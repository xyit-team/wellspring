/*
 * win-sandbox：Windows 用户态沙盒启动器
 *
 * 三个子命令：
 *   --prepare --workspace W --scratch S --sid-r SID --sid-w SID
 *       给 workspace / scratch 写入可继承的 ACL：SID_R 读，SID_W 改；scratch 两者都可写。
 *   --cleanup --workspace W [--scratch S] --sid-r SID --sid-w SID
 *       递归删除 workspace（以及可选 scratch）里本沙盒加的 ACE。
 *   --exec --access read-only|workspace-write --workspace W --scratch S --cwd C
 *          --sid-r SID --sid-w SID --memory-mb N --pids N -- COMMAND [ARGS...]
 *       创建 write-restricted token + Job Object，启动目标进程并等待。
 *
 * 安全要点：
 *   - DISABLE_MAX_PRIVILEGE：去掉 SeBackup/SeRestore/SeTakeOwnership/SeDebug 等；
 *   - WRITE_RESTRICTED：restricting SID 只参与写访问检查，读全局放开（与 DSH 对齐）；
 *   - 句柄白名单只放 stdin/stdout/stderr；
 *   - Job Object：kill-on-close、进程数、提交内存上限。
 *
 * 退出码：0 成功；1 用法错误；2 平台/参数错误；3 ACL 失败；4 token 失败；
 *         5 Job Object 失败；6 启动失败；目标进程的退出码原样返回。
 */

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>

#include <algorithm>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

namespace {

constexpr int EXIT_USAGE = 1;
constexpr int EXIT_PLATFORM = 2;
constexpr int EXIT_ACL = 3;
constexpr int EXIT_TOKEN = 4;
constexpr int EXIT_JOB = 5;
constexpr int EXIT_SPAWN = 6;

void print_error(const wchar_t *what, DWORD code) {
    wchar_t *buffer = nullptr;
    FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM |
                       FORMAT_MESSAGE_IGNORE_INSERTS,
                   nullptr, code, 0, reinterpret_cast<LPWSTR>(&buffer), 0, nullptr);
    fwprintf(stderr, L"win-sandbox: %ls failed (error %lu): %ls\n", what,
             static_cast<unsigned long>(code), buffer == nullptr ? L"(unknown)" : buffer);
    if (buffer != nullptr) {
        LocalFree(buffer);
    }
}

void print_message(const wchar_t *format, ...) {
    va_list args;
    va_start(args, format);
    vfwprintf(stderr, format, args);
    va_end(args);
}

bool is_windows_path(const std::wstring &path) {
    return path.size() >= 2 && path[1] == L':';
}

std::wstring full_path(const std::wstring &path) {
    DWORD size = GetFullPathNameW(path.c_str(), 0, nullptr, nullptr);
    if (size == 0) {
        return L"";
    }
    std::vector<wchar_t> buffer(size + 1);
    DWORD written = GetFullPathNameW(path.c_str(), static_cast<DWORD>(buffer.size()),
                                     buffer.data(), nullptr);
    if (written == 0 || written >= buffer.size()) {
        return L"";
    }
    return std::wstring(buffer.data(), written);
}

bool is_inside(const std::wstring &root, const std::wstring &target) {
    if (root.empty() || target.empty()) {
        return false;
    }
    std::wstring r = root;
    if (!r.empty() && (r.back() == L'\\' || r.back() == L'/')) {
        r.pop_back();
    }
    if (target.size() <= r.size()) {
        return _wcsicmp(target.c_str(), r.c_str()) == 0;
    }
    if (_wcsnicmp(target.c_str(), r.c_str(), r.size()) != 0) {
        return false;
    }
    return target[r.size()] == L'\\' || target[r.size()] == L'/';
}

bool owned_sid(PSID sid, PSID sid_r, PSID sid_w) {
    return (sid_r != nullptr && EqualSid(sid, sid_r)) ||
           (sid_w != nullptr && EqualSid(sid, sid_w));
}

/*
 * 重写 path 的 DACL：先删除 SID_R/SID_W 的旧 ACE，再追加本次需要的 ACE。
 * 只动自己的 SID，不重写其他 ACE；继承标志保留在拷贝的旧 ACE 上。
 */
DWORD apply_path_acl(const std::wstring &path, PSID sid_r, PSID sid_w, bool scratch) {
    PACL old_dacl = nullptr;
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    DWORD error = GetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT,
                                        DACL_SECURITY_INFORMATION, nullptr, nullptr, &old_dacl,
                                        nullptr, &descriptor);
    if (error != ERROR_SUCCESS) {
        return error;
    }

    const DWORD access_r = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE;
    const DWORD access_w =
        FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE;
    const DWORD flags = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
    const DWORD sid_r_len = GetLengthSid(sid_r);
    const DWORD sid_w_len = GetLengthSid(sid_w);
    const DWORD extra = 2 * (static_cast<DWORD>(sizeof(ACCESS_ALLOWED_ACE)) +
                             std::max(sid_r_len, sid_w_len)) +
                        64;
    const DWORD size = (old_dacl == nullptr ? sizeof(ACL) : old_dacl->AclSize) + extra;
    std::vector<BYTE> storage(size);
    PACL new_dacl = reinterpret_cast<PACL>(storage.data());
    if (!InitializeAcl(new_dacl, size, ACL_REVISION)) {
        error = GetLastError();
        LocalFree(descriptor);
        return error;
    }

    if (old_dacl != nullptr) {
        ACL_SIZE_INFORMATION info{};
        if (!GetAclInformation(old_dacl, &info, sizeof(info), AclSizeInformation)) {
            error = GetLastError();
            LocalFree(descriptor);
            return error;
        }
        for (DWORD index = 0; index < info.AceCount; ++index) {
            void *ace = nullptr;
            if (!GetAce(old_dacl, index, &ace)) {
                error = GetLastError();
                LocalFree(descriptor);
                return error;
            }
            auto *header = static_cast<ACE_HEADER *>(ace);
            bool drop = false;
            if (header->AceType == ACCESS_ALLOWED_ACE_TYPE ||
                header->AceType == ACCESS_DENIED_ACE_TYPE) {
                auto *allowed = static_cast<ACCESS_ALLOWED_ACE *>(ace);
                drop = owned_sid(reinterpret_cast<PSID>(&allowed->SidStart), sid_r, sid_w);
            }
            if (drop) {
                continue;
            }
            if (!AddAce(new_dacl, ACL_REVISION, MAXDWORD, ace, header->AceSize)) {
                error = GetLastError();
                LocalFree(descriptor);
                return error;
            }
        }
    }

    if (scratch) {
        if (!AddAccessAllowedAceEx(new_dacl, ACL_REVISION, flags, access_w, sid_r) ||
            !AddAccessAllowedAceEx(new_dacl, ACL_REVISION, flags, access_w, sid_w)) {
            error = GetLastError();
            LocalFree(descriptor);
            return error;
        }
    } else {
        if (!AddAccessAllowedAceEx(new_dacl, ACL_REVISION, flags, access_r, sid_r) ||
            !AddAccessAllowedAceEx(new_dacl, ACL_REVISION, flags, access_w, sid_w)) {
            error = GetLastError();
            LocalFree(descriptor);
            return error;
        }
    }

    error = SetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT,
                                  DACL_SECURITY_INFORMATION, nullptr, nullptr, new_dacl, nullptr);
    LocalFree(descriptor);
    return error;
}

/*
 * v1 只接受本地固定盘/可移动盘上的普通目录：
 *   - 网络映射盘（DRIVE_REMOTE）拒绝，避免 ACL 跨网络传播；
 *   - reparse point（junction / OneDrive 占位目录等）拒绝，避免写边界被重定向绕过。
 */
DWORD validate_storage_path(const std::wstring &path) {
    if (!is_windows_path(path) || path.size() <= 3 || path[2] != L'\\') {
        return ERROR_INVALID_NAME;
    }
    DWORD attributes = GetFileAttributesW(path.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES) {
        return GetLastError();
    }
    if ((attributes & FILE_ATTRIBUTE_DIRECTORY) == 0) {
        return ERROR_DIRECTORY;
    }
    if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
        return ERROR_NOT_SUPPORTED;
    }
    wchar_t root[4] = {path[0], L':', L'\\', L'\0'};
    UINT type = GetDriveTypeW(root);
    if (type == DRIVE_REMOTE || type == DRIVE_UNKNOWN || type == DRIVE_NO_ROOT_DIR ||
        type == DRIVE_CDROM) {
        return ERROR_NOT_SUPPORTED;
    }
    return ERROR_SUCCESS;
}

/* 从单个路径的 DACL 里删掉 SID_R/SID_W 的 ACE；其他 ACE 原样保留 */
DWORD remove_path_aces(const std::wstring &path, PSID sid_r, PSID sid_w) {
    PACL old_dacl = nullptr;
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    DWORD error = GetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT,
                                        DACL_SECURITY_INFORMATION, nullptr, nullptr, &old_dacl,
                                        nullptr, &descriptor);
    if (error != ERROR_SUCCESS) {
        return error;
    }
    if (old_dacl == nullptr) {
        LocalFree(descriptor);
        return ERROR_SUCCESS;
    }

    const DWORD size = old_dacl->AclSize + 64;
    std::vector<BYTE> storage(size);
    PACL new_dacl = reinterpret_cast<PACL>(storage.data());
    if (!InitializeAcl(new_dacl, size, ACL_REVISION)) {
        error = GetLastError();
        LocalFree(descriptor);
        return error;
    }

    ACL_SIZE_INFORMATION info{};
    if (!GetAclInformation(old_dacl, &info, sizeof(info), AclSizeInformation)) {
        error = GetLastError();
        LocalFree(descriptor);
        return error;
    }
    for (DWORD index = 0; index < info.AceCount; ++index) {
        void *ace = nullptr;
        if (!GetAce(old_dacl, index, &ace)) {
            error = GetLastError();
            LocalFree(descriptor);
            return error;
        }
        auto *header = static_cast<ACE_HEADER *>(ace);
        if (header->AceType == ACCESS_ALLOWED_ACE_TYPE ||
            header->AceType == ACCESS_DENIED_ACE_TYPE) {
            auto *allowed = static_cast<ACCESS_ALLOWED_ACE *>(ace);
            if (owned_sid(reinterpret_cast<PSID>(&allowed->SidStart), sid_r, sid_w)) {
                continue;
            }
        }
        if (!AddAce(new_dacl, ACL_REVISION, MAXDWORD, ace, header->AceSize)) {
            error = GetLastError();
            LocalFree(descriptor);
            return error;
        }
    }

    error = SetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT,
                                  DACL_SECURITY_INFORMATION, nullptr, nullptr, new_dacl, nullptr);
    LocalFree(descriptor);
    return error;
}

/* 递归清理 workspace 已有子项上的 ACE；只删自己的 SID，不碰其他 ACL */
DWORD cleanup_tree(const std::wstring &path, PSID sid_r, PSID sid_w) {
    DWORD error = remove_path_aces(path, sid_r, sid_w);
    if (error != ERROR_SUCCESS) {
        return error;
    }

    std::wstring pattern = path + L"\\*";
    WIN32_FIND_DATAW data{};
    HANDLE find = FindFirstFileW(pattern.c_str(), &data);
    if (find == INVALID_HANDLE_VALUE) {
        error = GetLastError();
        return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND ? ERROR_SUCCESS
                                                                              : error;
    }
    do {
        if (wcscmp(data.cFileName, L".") == 0 || wcscmp(data.cFileName, L"..") == 0) {
            continue;
        }
        std::wstring child = path + L"\\" + data.cFileName;
        if ((data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
            /* 不跟随 junction / symlink，避免清理到工作区之外 */
            if ((data.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0) {
                error = cleanup_tree(child, sid_r, sid_w);
                if (error != ERROR_SUCCESS) {
                    break;
                }
            }
        } else {
            error = remove_path_aces(child, sid_r, sid_w);
            if (error != ERROR_SUCCESS) {
                break;
            }
        }
    } while (FindNextFileW(find, &data));
    if (error == ERROR_SUCCESS) {
        error = GetLastError();
        if (error == ERROR_NO_MORE_FILES) {
            error = ERROR_SUCCESS;
        }
    }
    FindClose(find);
    return error;
}

std::wstring quote_arg(const std::wstring &arg) {    if (arg.empty()) {
        return L"\"\"";
    }
    if (arg.find_first_of(L" \t\"") == std::wstring::npos) {
        return arg;
    }
    std::wstring out = L"\"";
    size_t backslashes = 0;
    for (wchar_t ch : arg) {
        if (ch == L'\\') {
            ++backslashes;
        } else if (ch == L'"') {
            out.append(backslashes * 2 + 1, L'\\');
            out.push_back(L'"');
            backslashes = 0;
        } else {
            out.append(backslashes, L'\\');
            backslashes = 0;
            out.push_back(ch);
        }
    }
    out.append(backslashes * 2, L'\\');
    out.push_back(L'"');
    return out;
}

std::wstring build_command_line(const std::vector<std::wstring> &args) {
    std::wstring line;
    for (size_t index = 0; index < args.size(); ++index) {
        if (index != 0) {
            line.push_back(L' ');
        }
        line += quote_arg(args[index]);
    }
    return line;
}

PSID parse_sid(const std::wstring &text) {
    PSID sid = nullptr;
    if (!ConvertStringSidToSidW(text.c_str(), &sid)) {
        return nullptr;
    }
    if (!IsValidSid(sid)) {
        LocalFree(sid);
        return nullptr;
    }
    return sid;
}

HANDLE create_restricted_token(PSID restricting_sid) {
    HANDLE current = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(),
                          TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY, &current)) {
        print_error(L"OpenProcessToken", GetLastError());
        return nullptr;
    }

    /*
     * 除业务 SID 外再带上 RESTRICTED 与 Everyone：只写受限 token 仍要能创建/打开
     * 受限对象，否则 node / PowerShell 之类的进程会在 DLL 初始化或对象创建阶段失败。
     * Everyone 本身不授予 workspace 写权限（写边界仍由业务 SID 的 ACE 决定）；
     * 已知例外：Everyone 显式可写的位置。
     */
    BYTE restricted_buffer[SECURITY_MAX_SID_SIZE] = {};
    DWORD restricted_size = sizeof(restricted_buffer);
    if (!CreateWellKnownSid(WinRestrictedCodeSid, nullptr, restricted_buffer, &restricted_size)) {
        print_error(L"CreateWellKnownSid", GetLastError());
        CloseHandle(current);
        return nullptr;
    }
    BYTE everyone_buffer[SECURITY_MAX_SID_SIZE] = {};
    DWORD everyone_size = sizeof(everyone_buffer);
    if (!CreateWellKnownSid(WinWorldSid, nullptr, everyone_buffer, &everyone_size)) {
        print_error(L"CreateWellKnownSid", GetLastError());
        CloseHandle(current);
        return nullptr;
    }
    SID_AND_ATTRIBUTES restrict[3] = {};
    restrict[0].Sid = restricting_sid;
    restrict[0].Attributes = 0;
    restrict[1].Sid = reinterpret_cast<PSID>(restricted_buffer);
    restrict[1].Attributes = 0;
    restrict[2].Sid = reinterpret_cast<PSID>(everyone_buffer);
    restrict[2].Attributes = 0;

    HANDLE restricted = nullptr;
    if (!CreateRestrictedToken(current, DISABLE_MAX_PRIVILEGE | WRITE_RESTRICTED, 0, nullptr, 0,
                               nullptr, 3, restrict, &restricted)) {
        print_error(L"CreateRestrictedToken", GetLastError());
        CloseHandle(current);
        return nullptr;
    }
    CloseHandle(current);
    return restricted;
}

HANDLE create_job(DWORD pids, DWORD memory_mb) {
    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    if (job == nullptr) {
        print_error(L"CreateJobObject", GetLastError());
        return nullptr;
    }

    JOBOBJECT_EXTENDED_LIMIT_INFORMATION info{};
    info.BasicLimitInformation.LimitFlags =
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
    info.BasicLimitInformation.ActiveProcessLimit = pids == 0 ? 64 : pids;
    if (memory_mb > 0) {
        info.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_JOB_MEMORY;
        info.JobMemoryLimit = static_cast<SIZE_T>(memory_mb) * 1024 * 1024;
    }
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &info, sizeof(info))) {
        print_error(L"SetInformationJobObject", GetLastError());
        CloseHandle(job);
        return nullptr;
    }
    return job;
}

int run_command_with_token(const std::wstring &command, const std::wstring &cwd,
                           PSID restricting_sid, DWORD pids, DWORD memory_mb) {
    HANDLE token = create_restricted_token(restricting_sid);
    if (token == nullptr) {
        return EXIT_TOKEN;
    }
    HANDLE job = create_job(pids, memory_mb);
    if (job == nullptr) {
        CloseHandle(token);
        return EXIT_JOB;
    }

    std::wstring line = command;
    std::vector<wchar_t> mutable_line(line.begin(), line.end());
    mutable_line.push_back(L'\0');

    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    HANDLE std_handles[3] = {GetStdHandle(STD_INPUT_HANDLE), GetStdHandle(STD_OUTPUT_HANDLE),
                             GetStdHandle(STD_ERROR_HANDLE)};
    for (HANDLE handle : std_handles) {
        if (handle == nullptr || handle == INVALID_HANDLE_VALUE) {
            print_message(L"win-sandbox: stdin/stdout/stderr 不可继承\n");
            CloseHandle(job);
            CloseHandle(token);
            return EXIT_SPAWN;
        }
    }

    SIZE_T attribute_size = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &attribute_size);
    auto *attributes = static_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(
        HeapAlloc(GetProcessHeap(), 0, attribute_size));
    if (attributes == nullptr ||
        !InitializeProcThreadAttributeList(attributes, 1, 0, &attribute_size)) {
        print_error(L"InitializeProcThreadAttributeList", GetLastError());
        if (attributes != nullptr) {
            HeapFree(GetProcessHeap(), 0, attributes);
        }
        CloseHandle(job);
        CloseHandle(token);
        return EXIT_SPAWN;
    }
    if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, std_handles,
                                   sizeof(std_handles), nullptr, nullptr)) {
        print_error(L"UpdateProcThreadAttribute", GetLastError());
        DeleteProcThreadAttributeList(attributes);
        HeapFree(GetProcessHeap(), 0, attributes);
        CloseHandle(job);
        CloseHandle(token);
        return EXIT_SPAWN;
    }
    startup.lpAttributeList = attributes;

    PROCESS_INFORMATION process{};
    DWORD creation_flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT |
                           EXTENDED_STARTUPINFO_PRESENT;
    if (!CreateProcessAsUserW(token, nullptr, mutable_line.data(), nullptr, nullptr, TRUE,
                              creation_flags, nullptr, cwd.empty() ? nullptr : cwd.c_str(),
                              &startup.StartupInfo, &process)) {
        print_error(L"CreateProcessAsUser", GetLastError());
        DeleteProcThreadAttributeList(attributes);
        HeapFree(GetProcessHeap(), 0, attributes);
        CloseHandle(job);
        CloseHandle(token);
        return EXIT_SPAWN;
    }

    DeleteProcThreadAttributeList(attributes);
    HeapFree(GetProcessHeap(), 0, attributes);

    if (!AssignProcessToJobObject(job, process.hProcess)) {
        print_error(L"AssignProcessToJobObject", GetLastError());
        TerminateProcess(process.hProcess, EXIT_JOB);
        WaitForSingleObject(process.hProcess, 5000);
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        CloseHandle(job);
        CloseHandle(token);
        return EXIT_JOB;
    }

    if (ResumeThread(process.hThread) == static_cast<DWORD>(-1)) {
        print_error(L"ResumeThread", GetLastError());
        TerminateProcess(process.hProcess, EXIT_SPAWN);
        WaitForSingleObject(process.hProcess, 5000);
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        CloseHandle(job);
        CloseHandle(token);
        return EXIT_SPAWN;
    }
    CloseHandle(process.hThread);

    WaitForSingleObject(process.hProcess, INFINITE);
    DWORD exit_code = EXIT_SPAWN;
    GetExitCodeProcess(process.hProcess, &exit_code);
    CloseHandle(process.hProcess);
    CloseHandle(job);
    CloseHandle(token);
    return static_cast<int>(exit_code);
}

int self_test() {
    PSID sid = parse_sid(L"S-1-5-21-111111111-222222222-333333333-1001");
    if (sid == nullptr) {
        print_message(L"win-sandbox: self-test SID 无效\n");
        return EXIT_PLATFORM;
    }
    wchar_t system_dir[MAX_PATH] = {};
    if (GetSystemDirectoryW(system_dir, MAX_PATH) == 0) {
        LocalFree(sid);
        return EXIT_PLATFORM;
    }
    std::wstring cmd = std::wstring(system_dir) + L"\\cmd.exe /c exit 0";
    int code = run_command_with_token(cmd, L"", sid, 8, 0);
    LocalFree(sid);
    if (code != 0) {
        print_message(L"win-sandbox: self-test 失败，退出码 %d\n", code);
        return code == EXIT_TOKEN || code == EXIT_JOB || code == EXIT_SPAWN ? code : EXIT_SPAWN;
    }
    wprintf(L"win-sandbox: ok\n");
    return 0;
}

struct ExecOptions {
    std::string access;
    std::wstring workspace;
    std::wstring scratch;
    std::wstring cwd;
    std::wstring sid_r;
    std::wstring sid_w;
    DWORD memory_mb = 512;
    DWORD pids = 64;
    std::vector<std::wstring> command;
};

}  // namespace

int wmain(int argc, wchar_t **argv) {
    if (argc < 2) {
        print_message(L"用法：win-sandbox --prepare|--exec|--self-test\n");
        return EXIT_USAGE;
    }
    std::wstring mode = argv[1];
    if (mode == L"--self-test") {
        return self_test();
    }
    if (mode == L"--version") {
        wprintf(L"win-sandbox 1.0\n");
        return 0;
    }
    if (mode == L"--prepare") {
        std::wstring workspace;
        std::wstring scratch;
        std::wstring sid_r_text;
        std::wstring sid_w_text;
        for (int index = 2; index < argc; ++index) {
            std::wstring arg = argv[index];
            if (arg == L"--workspace" && index + 1 < argc) {
                workspace = argv[++index];
            } else if (arg == L"--scratch" && index + 1 < argc) {
                scratch = argv[++index];
            } else if (arg == L"--sid-r" && index + 1 < argc) {
                sid_r_text = argv[++index];
            } else if (arg == L"--sid-w" && index + 1 < argc) {
                sid_w_text = argv[++index];
            } else {
                print_message(L"win-sandbox: 未知参数 %ls\n", arg.c_str());
                return EXIT_USAGE;
            }
        }
        if (workspace.empty() || scratch.empty() || sid_r_text.empty() || sid_w_text.empty()) {
            print_message(L"win-sandbox: --prepare 缺少参数\n");
            return EXIT_USAGE;
        }
        if (!is_windows_path(workspace) || !is_windows_path(scratch)) {
            print_message(L"win-sandbox: workspace/scratch 必须是绝对 Windows 路径\n");
            return EXIT_PLATFORM;
        }
        PSID sid_r = parse_sid(sid_r_text);
        PSID sid_w = parse_sid(sid_w_text);
        if (sid_r == nullptr || sid_w == nullptr) {
            if (sid_r != nullptr) {
                LocalFree(sid_r);
            }
            if (sid_w != nullptr) {
                LocalFree(sid_w);
            }
            print_message(L"win-sandbox: SID 无效\n");
            return EXIT_PLATFORM;
        }
        std::wstring workspace_path = full_path(workspace);
        std::wstring scratch_path = full_path(scratch);
        DWORD error = validate_storage_path(workspace_path);
        if (error == ERROR_SUCCESS) {
            error = validate_storage_path(scratch_path);
        }
        if (error == ERROR_SUCCESS) {
            error = apply_path_acl(workspace_path, sid_r, sid_w, false);
        }
        if (error == ERROR_SUCCESS) {
            error = apply_path_acl(scratch_path, sid_r, sid_w, true);
        }
        LocalFree(sid_r);
        LocalFree(sid_w);
        if (error != ERROR_SUCCESS) {
            print_error(L"prepare", error);
            return EXIT_ACL;
        }
        return 0;
    }

    if (mode == L"--cleanup") {
        std::wstring workspace;
        std::wstring scratch;
        std::wstring sid_r_text;
        std::wstring sid_w_text;
        for (int index = 2; index < argc; ++index) {
            std::wstring arg = argv[index];
            if (arg == L"--workspace" && index + 1 < argc) {
                workspace = argv[++index];
            } else if (arg == L"--scratch" && index + 1 < argc) {
                scratch = argv[++index];
            } else if (arg == L"--sid-r" && index + 1 < argc) {
                sid_r_text = argv[++index];
            } else if (arg == L"--sid-w" && index + 1 < argc) {
                sid_w_text = argv[++index];
            } else {
                print_message(L"win-sandbox: 未知参数 %ls\n", arg.c_str());
                return EXIT_USAGE;
            }
        }
        if (workspace.empty() || sid_r_text.empty() || sid_w_text.empty()) {
            print_message(L"win-sandbox: --cleanup 缺少参数\n");
            return EXIT_USAGE;
        }
        if (!is_windows_path(workspace) || (!scratch.empty() && !is_windows_path(scratch))) {
            print_message(L"win-sandbox: workspace/scratch 必须是绝对 Windows 路径\n");
            return EXIT_PLATFORM;
        }
        PSID sid_r = parse_sid(sid_r_text);
        PSID sid_w = parse_sid(sid_w_text);
        if (sid_r == nullptr || sid_w == nullptr) {
            if (sid_r != nullptr) {
                LocalFree(sid_r);
            }
            if (sid_w != nullptr) {
                LocalFree(sid_w);
            }
            print_message(L"win-sandbox: SID 无效\n");
            return EXIT_PLATFORM;
        }
        std::wstring workspace_path = full_path(workspace);
        std::wstring scratch_path = scratch.empty() ? L"" : full_path(scratch);
        /* 工作区已删除时清理算成功；其他错误照常报告 */
        DWORD error = cleanup_tree(workspace_path, sid_r, sid_w);
        if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) {
            error = ERROR_SUCCESS;
        }
        if (error == ERROR_SUCCESS && !scratch_path.empty()) {
            error = cleanup_tree(scratch_path, sid_r, sid_w);
            if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) {
                error = ERROR_SUCCESS;
            }
        }
        LocalFree(sid_r);
        LocalFree(sid_w);
        if (error != ERROR_SUCCESS) {
            print_error(L"cleanup", error);
            return EXIT_ACL;
        }
        return 0;
    }

    if (mode == L"--exec") {
        ExecOptions options;
        for (int index = 2; index < argc; ++index) {
            std::wstring arg = argv[index];
            if (arg == L"--") {
                for (int rest = index + 1; rest < argc; ++rest) {
                    options.command.emplace_back(argv[rest]);
                }
                break;
            }
            if (arg == L"--access" && index + 1 < argc) {
                std::wstring value = argv[++index];
                options.access = value == L"workspace-write" ? "workspace-write" : "read-only";
            } else if (arg == L"--workspace" && index + 1 < argc) {
                options.workspace = argv[++index];
            } else if (arg == L"--scratch" && index + 1 < argc) {
                options.scratch = argv[++index];
            } else if (arg == L"--cwd" && index + 1 < argc) {
                options.cwd = argv[++index];
            } else if (arg == L"--sid-r" && index + 1 < argc) {
                options.sid_r = argv[++index];
            } else if (arg == L"--sid-w" && index + 1 < argc) {
                options.sid_w = argv[++index];
            } else if (arg == L"--memory-mb" && index + 1 < argc) {
                options.memory_mb = static_cast<DWORD>(_wtoi(argv[++index]));
            } else if (arg == L"--pids" && index + 1 < argc) {
                options.pids = static_cast<DWORD>(_wtoi(argv[++index]));
            } else {
                print_message(L"win-sandbox: 未知参数 %ls\n", arg.c_str());
                return EXIT_USAGE;
            }
        }
        if (options.command.empty() || options.workspace.empty() || options.cwd.empty() ||
            options.sid_r.empty() || options.sid_w.empty()) {
            print_message(L"win-sandbox: --exec 缺少参数\n");
            return EXIT_USAGE;
        }
        std::wstring workspace = full_path(options.workspace);
        std::wstring cwd = full_path(options.cwd);
        if (!is_inside(workspace, cwd)) {
            print_message(L"win-sandbox: cwd 不在 workspace 内\n");
            return EXIT_PLATFORM;
        }
        PSID sid_r = parse_sid(options.sid_r);
        PSID sid_w = parse_sid(options.sid_w);
        if (sid_r == nullptr || sid_w == nullptr) {
            if (sid_r != nullptr) {
                LocalFree(sid_r);
            }
            if (sid_w != nullptr) {
                LocalFree(sid_w);
            }
            print_message(L"win-sandbox: SID 无效\n");
            return EXIT_PLATFORM;
        }
        PSID restricting = options.access == "workspace-write" ? sid_w : sid_r;
        std::wstring command_line = build_command_line(options.command);
        int code = run_command_with_token(command_line, cwd, restricting, options.pids,
                                          options.memory_mb);
        LocalFree(sid_r);
        LocalFree(sid_w);
        return code;
    }

    print_message(L"win-sandbox: 未知模式 %ls\n", mode.c_str());
    return EXIT_USAGE;
}
