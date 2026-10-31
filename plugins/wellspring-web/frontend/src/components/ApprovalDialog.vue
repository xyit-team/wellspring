<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue"

import { respondApproval, store } from "../store"

const dialogEl = ref<HTMLDialogElement | null>(null)

function show(): void {
    if (dialogEl.value !== null && !dialogEl.value.open) dialogEl.value.showModal()
}

onMounted(() => {
    if (store.approval !== null) show()
})
watch(
    () => store.approval !== null,
    (open) => {
        if (open) show()
        else if (dialogEl.value?.open) dialogEl.value.close()
    },
)

/** 标准输入预览上限：够看清意图，又不会把对话框撑爆 */
const STDIN_PREVIEW = 1200

/**
 * 参数列表
 *
 * 以前这个对话框只显示 command（可执行文件名），而 execute_code 的危险部分全在 argv 里：
 * command="bash" 看不出后面接的是 -lc "curl … | sh"。这里把每个参数单独列出，
 * 让人能分辨「一个带空格的参数」和「两条串联的命令」。
 */
const args = computed(() => (Array.isArray(store.approval?.argv) ? store.approval.argv : []))

/** POSIX 风格还原引号：整行读起来就是终端里会执行的那一行 */
function shellQuote(value: string): string {
    if (value === "") return "''"
    if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
    return `'${value.replace(/'/g, `'\\''`)}'`
}

const commandLine = computed(() => {
    const approval = store.approval
    if (approval === null) return ""
    return [approval.command, ...args.value].map(shellQuote).join(" ")
})

const stdinPreview = computed(() => {
    const value = store.approval?.stdin ?? ""
    return value.length > STDIN_PREVIEW ? `${value.slice(0, STDIN_PREVIEW)}…` : value
})

const stdinTruncated = computed(() => (store.approval?.stdin?.length ?? 0) > STDIN_PREVIEW)
</script>

<template>
    <dialog
        ref="dialogEl"
        class="dialog dialog-wide"
        aria-labelledby="approval-title"
        @close="store.approval = null"
    >
        <div class="dialog-head">
            <div>
                <h2 id="approval-title">Agent 请求提升权限</h2>
                <p>执行这次调用需要比当前更高的权限，仅对本次调用生效。</p>
            </div>
        </div>
        <div class="dialog-body">
            <!-- 整行命令放在最上面：这才是真正会被执行的东西 -->
            <p class="approval-command-line">
                <code>{{ commandLine }}</code>
            </p>
            <dl class="status-grid">
                <template v-if="args.length > 0">
                    <dt>参数</dt>
                    <dd>
                        <ol class="approval-args">
                            <li v-for="(arg, index) in args" :key="index">
                                <span class="approval-arg-index">{{ index }}</span>
                                <code>{{ arg }}</code>
                            </li>
                        </ol>
                    </dd>
                </template>
                <dt>工作目录</dt>
                <dd class="approval-path">{{ store.approval?.cwd ?? "—" }}</dd>
                <dt>权限</dt>
                <dd>
                    {{ store.approval?.currentPermission ?? "—" }} →
                    {{ store.approval?.requestedPermission ?? "—" }}
                </dd>
                <template v-if="store.approval?.network === true">
                    <dt>网络</dt>
                    <dd class="approval-risk">允许联网</dd>
                </template>
                <template v-if="store.approval?.background === true">
                    <dt>运行方式</dt>
                    <dd class="approval-risk">后台执行（本轮结束后仍在运行）</dd>
                </template>
                <template v-if="typeof store.approval?.timeoutMs === 'number'">
                    <dt>超时</dt>
                    <dd>{{ Math.round((store.approval?.timeoutMs ?? 0) / 1000) }} 秒</dd>
                </template>
                <template v-if="stdinPreview !== ''">
                    <dt>标准输入</dt>
                    <dd>
                        <pre class="approval-stdin">{{ stdinPreview }}</pre>
                        <span v-if="stdinTruncated" class="approval-note">
                            只显示前 {{ STDIN_PREVIEW }} 个字符
                        </span>
                    </dd>
                </template>
                <template v-if="store.approval?.justification">
                    <dt>理由</dt>
                    <dd>{{ store.approval.justification }}</dd>
                </template>
            </dl>
        </div>
        <div class="dialog-foot">
            <button class="btn btn-outline" type="button" @click="respondApproval(false)">
                拒绝
            </button>
            <button class="btn btn-danger" type="button" @click="respondApproval(true)">
                允许这次执行
            </button>
        </div>
    </dialog>
</template>
