/*
 * macOS Seatbelt loader
 *
 * 两件事：把 SBPL profile 交给内核，用绝对路径 exec 目标命令
 * 沙箱是进程属性，跨 exec 保留，目标命令及其后代共用同一份限制
 *
 * 与 /usr/bin/sandbox-exec 的差别：
 *   该 CLI 自 macOS 10.10 起 deprecated，后续版本可能移除
 *   它是 spawn 的对象，PATH 含模型可写目录（node_modules/.bin）时会被同名文件顶替，
 *   伪造者丢掉 -p 的 profile 换成 (allow default) 即令沙箱失效
 *   本二进制的目标命令只接受绝对路径，不做名字解析
 *
 * 退出码：0 成功或 --self-test 通过，1 用法错误，2 libsandbox 不可用，
 * 3 sandbox_init 拒绝 profile，4 exec 失败
 */

#include <dlfcn.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

#define EXIT_USAGE 1
#define EXIT_LOADER 2
#define EXIT_PROFILE 3
#define EXIT_EXEC 4

/* macOS 私有 API：sandbox_init(const char *profile, uint64_t flags, char **errorbuf) */
typedef int (*sandbox_init_fn)(const char *profile, uint64_t flags, char **errorbuf);
typedef void (*sandbox_free_error_fn)(char *errorbuf);

typedef struct {
    sandbox_init_fn init;
    sandbox_free_error_fn free_error;
} sandbox_api;

static const char *const LIBSANDBOX = "/usr/lib/libsandbox.1.dylib";

static void usage(const char *self) {
    fprintf(stderr,
            "用法：%s -p <profile> <绝对路径命令> [args...]\n"
            "      %s --self-test\n",
            self, self);
}

/* 加载 libsandbox 并解析符号，失败返回 0 */
static int load_api(sandbox_api *api) {
    memset(api, 0, sizeof(*api));
    void *handle = dlopen(LIBSANDBOX, RTLD_NOW | RTLD_LOCAL);
    if (handle == NULL) {
        const char *reason = dlerror();
        fprintf(stderr, "seatbelt-run: 无法加载 %s：%s\n", LIBSANDBOX,
                reason == NULL ? "未知原因" : reason);
        return 0;
    }
    /* 不 dlclose，进程随后 exec */
    /* dlsym 返回 void*，经 memcpy 落地 */
    void *init_symbol = dlsym(handle, "sandbox_init");
    void *free_symbol = dlsym(handle, "sandbox_free_error");
    memcpy(&api->init, &init_symbol, sizeof(init_symbol));
    memcpy(&api->free_error, &free_symbol, sizeof(free_symbol));
    if (api->init == NULL) {
        fprintf(stderr, "seatbelt-run: %s 里没有 sandbox_init\n", LIBSANDBOX);
        return 0;
    }
    return 1;
}

/* 施加 profile，失败时输出内核给出的原因 */
static int apply_profile(const sandbox_api *api, const char *profile) {
    char *error = NULL;
    if (api->init(profile, 0, &error) != 0) {
        fprintf(stderr, "seatbelt-run: sandbox_init 拒绝该 profile：%s\n",
                error == NULL ? "未知原因" : error);
        if (error != NULL && api->free_error != NULL) {
            api->free_error(error);
        }
        return 0;
    }
    return 1;
}

/*
 * 端到端自检：子进程施加最宽松的 profile 再 exec /usr/bin/true
 * dlsym 成功只证明符号存在，不证明内核接受这份 profile
 */
static int self_test(const sandbox_api *api) {
    static const char *const PERMISSIVE = "(version 1)(allow default)";
    static const char *const PROBE_COMMAND = "/usr/bin/true";

    pid_t pid = fork();
    if (pid < 0) {
        fprintf(stderr, "seatbelt-run: fork 失败：%s\n", strerror(errno));
        return EXIT_LOADER;
    }
    if (pid == 0) {
        if (!apply_profile(api, PERMISSIVE)) {
            _exit(EXIT_PROFILE);
        }
        char *const argv[] = {(char *)PROBE_COMMAND, NULL};
        execve(PROBE_COMMAND, argv, environ);
        _exit(EXIT_EXEC);
    }

    int status = 0;
    while (waitpid(pid, &status, 0) < 0) {
        if (errno != EINTR) {
            fprintf(stderr, "seatbelt-run: waitpid 失败：%s\n", strerror(errno));
            return EXIT_LOADER;
        }
    }
    if (!WIFEXITED(status)) {
        fprintf(stderr, "seatbelt-run: 自检子进程异常退出\n");
        return EXIT_EXEC;
    }
    if (WEXITSTATUS(status) != 0) {
        fprintf(stderr, "seatbelt-run: 自检失败（子进程退出码 %d）\n", WEXITSTATUS(status));
        return WEXITSTATUS(status);
    }
    return 0;
}

int main(int argc, char **argv) {
    if (argc < 2) {
        usage(argv[0]);
        return EXIT_USAGE;
    }

    sandbox_api api;
    if (!load_api(&api)) {
        return EXIT_LOADER;
    }

    if (strcmp(argv[1], "--self-test") == 0) {
        int code = self_test(&api);
        if (code == 0) {
            printf("seatbelt-run: ok\n");
        }
        return code;
    }

    /* program -p profile target [args...]，最少 argc = 4 */
    if (strcmp(argv[1], "-p") != 0 || argc < 4) {
        usage(argv[0]);
        return EXIT_USAGE;
    }

    const char *profile = argv[2];
    const char *target = argv[3];

    /*
     * 绝对路径是这一层的不变量
     * 需要 PATH 解析的写法会被工作区里的同名文件劫持，而工作区正是被约束的对象
     */
    if (target[0] != '/') {
        fprintf(stderr, "seatbelt-run: 目标命令必须是绝对路径：%s\n", target);
        return EXIT_USAGE;
    }

    if (profile[0] == '\0') {
        fprintf(stderr, "seatbelt-run: profile 为空\n");
        return EXIT_USAGE;
    }

    if (!apply_profile(&api, profile)) {
        return EXIT_PROFILE;
    }

    execve(target, &argv[3], environ);

    /* exec 失败 */
    fprintf(stderr, "seatbelt-run: exec %s 失败：%s\n", target, strerror(errno));
    return EXIT_EXEC;
}
