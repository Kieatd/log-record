<script setup lang="ts">
import dayjs from 'dayjs';
import { computed, ref, watch } from 'vue';
import { message } from 'ant-design-vue';
import BodyViewer from './body-viewer.vue';
import { CopyOutlined, SendOutlined } from '@ant-design/icons-vue';
import { useI18n } from 'vue-i18n';

const [messageApi, contextHolder] = message.useMessage();
const i18n = useI18n();
const props = defineProps(['csn']);

const reqBody = computed(() => {
  try {
    if (!props.csn.reqBody) {
      return null;
    }
    return JSON.parse(props.csn.reqBody);
  } catch (error) {
    console.warn('解析响应体失败', error, props.csn.reqBody);
    return props.csn.reqBody;
  }
});

const resBody = computed(() => {
  try {
    return JSON.parse(props.csn.resBody);
  } catch (error) {
    console.warn('解析响应体失败', error);
    return props.csn?.resBody ?? null;
  }
});

// 把任意值整理成可读的纯文本：字符串若为 JSON 则美化，对象则美化输出
const formatForCopy = (raw: any): string => {
  if (raw === undefined || raw === null) {
    return '';
  }
  if (typeof raw === 'string') {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }
  if (typeof raw === 'object') {
    try {
      return JSON.stringify(raw, null, 2);
    } catch {
      return String(raw);
    }
  }
  return String(raw);
};

const copyText = async (text: any) => {
  try {
    await navigator.clipboard.writeText(formatForCopy(text));
    messageApi.info(i18n.t('复制成功'));
  } catch (err) {
    messageApi.warning(i18n.t('复制失败'));
    console.error('无法复制文本: ', err);
  }
};

/* ---------------- 重新请求（就地编辑请求信息后重发） ---------------- */

type SendResult = {
  ok: boolean;
  statusCode?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
  durationMs?: number;
  error?: string;
};

// 编辑模式：打开后只有「请求头 / 请求体」可编辑，地址和方法沿用原请求
const reRequestMode = ref(false);
// 请求头保持表格展示，只让「值」可编辑，所以按 [{key, value}] 存
const editHeaders = ref<Array<{ key: string; value: string }>>([]);
const editBodyText = ref('');
const sending = ref(false);
const reResult = ref<SendResult | null>(null);
// 结果块要显示「响应时间」，重发不像抓包有原始时间戳，收到即记
const reResultAt = ref<number | null>(null);

/** 用当前接口的数据填充编辑表单 */
const startReRequest = () => {
  editHeaders.value = Object.entries(props.csn?.reqHeaders ?? {}).map(
    ([key, value]) => ({ key, value: String(value) }),
  );
  editBodyText.value = formatForCopy(props.csn?.reqBody);
  reResult.value = null;
  reRequestMode.value = true;
};

const cancelReRequest = () => {
  reRequestMode.value = false;
  reResult.value = null;
};

const sendReRequest = async () => {
  // 地址和方法固定用原请求的，只发用户改过的请求头 / 请求体
  const url = String(props.csn?.url ?? '');
  if (!url) {
    message.warning(i18n.t('请求地址不能为空'));
    return;
  }
  sending.value = true;
  reResult.value = null;
  reResultAt.value = null;
  try {
    // 由主进程发出：渲染进程发会受 CORS 限制
    reResult.value = await window.electronAPI.sendRequest({
      method: String(props.csn?.method ?? 'GET').toUpperCase(),
      url,
      headers: Object.fromEntries(
        editHeaders.value
          .filter((item) => item.key.trim())
          .map((item) => [item.key.trim(), item.value]),
      ),
      body: editBodyText.value,
    });
  } catch (err: any) {
    reResult.value = { ok: false, error: err?.message ?? String(err) };
  } finally {
    reResultAt.value = Date.now();
    sending.value = false;
  }
};

const reResultBody = computed(() => {
  const raw = reResult.value?.body;
  if (!raw) {
    return '';
  }
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
});

const reResultTime = computed(() =>
  reResultAt.value
    ? dayjs(reResultAt.value).format('YYYY-MM-DD HH:mm:ss')
    : '',
);

const copyReResult = async () => {
  try {
    await navigator.clipboard.writeText(reResultBody.value);
    messageApi.info(i18n.t('复制成功'));
  } catch {
    messageApi.warning(i18n.t('复制失败'));
  }
};

// 换一条请求时退出编辑模式，避免表单里还留着上一条的内容
watch(
  () => props.csn?.id,
  () => {
    reRequestMode.value = false;
    reResult.value = null;
  },
);

/**
 * 复制请求参数：请求地址 + 空行 + 请求体。
 * 请求体为空时只复制地址。
 */
const copyRequestParams = () => {
  const url = String(props.csn?.url ?? '');
  if (!url) {
    return;
  }
  const body = formatForCopy(props.csn?.reqBody);
  if (!body) {
    copyText(url);
    return;
  }
  copyText(`${url}\n\n${body}`);
};

</script>

<template v-if="csn.url">
  <div class="format-text">
    <contextHolder />
    <div class="content-box">
      <!-- 复制按钮：在框内、请求地址上方（靠右） -->
      <div class="detail-toolbar">
        <!-- 展示态：复制 / 重新请求 -->
        <template v-if="!reRequestMode">
          <a-tooltip>
            <template #title>
              {{ $t('复制请求地址和请求体，中间空行隔开') }}
            </template>
            <a-button
              class="copy-params-btn"
              type="text"
              size="small"
              @click="copyRequestParams"
            >
              <template #icon><CopyOutlined /></template>
              {{ $t('复制请求参数') }}
            </a-button>
          </a-tooltip>
          <a-tooltip>
            <template #title>
              {{ $t('修改请求头和请求体后重新发送（由本机发出）') }}
            </template>
            <a-button
              class="copy-params-btn"
              type="text"
              size="small"
              @click="startReRequest"
            >
              <template #icon><SendOutlined /></template>
              {{ $t('重新请求') }}
            </a-button>
          </a-tooltip>
        </template>
        <!-- 编辑态：取消 / 发送请求 -->
        <template v-else>
          <a-button
            class="copy-params-btn"
            type="text"
            size="small"
            @click="cancelReRequest"
          >
            {{ $t('取消') }}
          </a-button>
          <a-button
            class="send-request-btn"
            type="primary"
            size="small"
            :loading="sending"
            @click="sendReRequest"
          >
            <template #icon><SendOutlined /></template>
            {{ $t('发送请求') }}
          </a-button>
        </template>
      </div>
      <div class="strip">
        <span class="label-item">{{ $t('请求地址：') }}</span>
        <span class="req-url">{{ csn.url }}</span>
      </div>
      <div class="strip">
        <span class="label-item">{{ $t('请求方法：') }}</span>
        <span class="req-url">{{ csn.method }}</span>
      </div>
      <div class="strip">
        <span class="label-item">{{ $t('请求时间：') }}</span>
        <span>
          {{ dayjs(csn.createTime).format('YYYY-MM-DD HH:mm:ss') }}
        </span>
      </div>
      <div class="strip">
        <span class="label-item">{{ $t('请求头：') }}</span>
        <!-- 始终是表格：编辑态只把「值」换成输入框，字段名保持只读 -->
        <div
          v-if="
            reRequestMode
              ? editHeaders.length !== 0
              : Object.keys(csn.reqHeaders ?? {}).length !== 0
          "
          class="headers-container"
        >
          <div
            v-if="reRequestMode"
            class="row-container"
            v-for="(item, index) in editHeaders"
            :key="index"
          >
            <span class="column-text">{{ item.key }}</span>
            <div class="column-value-edit">
              <a-input
                v-model:value="item.value"
                class="edit-value-input"
                size="small"
              />
            </div>
          </div>
          <div
            v-else
            class="row-container"
            v-for="(value, key) in csn.reqHeaders"
            :key="key"
          >
            <span class="column-text">{{ key }}</span>
            <span class="column-value-text">{{ value }}</span>
          </div>
        </div>
        <span v-else>{{ $t('空') }}</span>
      </div>
      <div class="strip">
        <span class="label-item">{{ $t('请求体：') }}</span>
        <a-textarea
          v-if="reRequestMode"
          v-model:value="editBodyText"
          class="edit-textarea"
          :rows="10"
          :placeholder="$t('请求体（GET/HEAD 会被忽略）')"
        />
        <BodyViewer
          v-else-if="csn.reqBody"
          :key="csn.id + 'reqBody'"
          :raw="csn.reqBody"
          search-placeholder="搜索请求体"
        />
        <span v-else>{{ $t('空') }}</span>
      </div>
      <!-- 编辑态：请求体下面也放一份，省得滚回顶部点发送 -->
      <div v-if="reRequestMode" class="edit-actions-bottom">
        <a-button
          class="copy-params-btn"
          type="text"
          size="small"
          @click="cancelReRequest"
        >
          {{ $t('取消') }}
        </a-button>
        <a-button
          class="send-request-btn"
          type="primary"
          size="small"
          :loading="sending"
          @click="sendReRequest"
        >
          <template #icon><SendOutlined /></template>
          {{ $t('发送请求') }}
        </a-button>
      </div>
    </div>
    <!-- 重新请求的结果：行结构、样式与下面「响应」块保持一致 -->
    <div v-if="reResult" class="content-box">
      <div class="re-result-title">{{ $t('重新请求结果') }}</div>
      <div class="strip">
        <span class="label-item">{{ $t('响应时间：') }}</span>
        <span>{{ reResultTime }}</span>
      </div>
      <div class="strip">
        <span class="label-item">{{ $t('响应状态：') }}</span>
        <span v-if="reResult.ok">
          {{ reResult.statusCode }} {{ reResult.statusText }}
          <span class="re-duration">{{ reResult.durationMs }} ms</span>
        </span>
        <span v-else class="re-error">{{ $t('请求失败') }}</span>
      </div>
      <div class="strip">
        <span class="label-item">{{ $t('响应头：') }}</span>
        <div
          v-if="Object.keys(reResult.headers ?? {}).length !== 0"
          class="headers-container"
        >
          <div
            class="row-container"
            v-for="(value, key) in reResult.headers"
            :key="key"
          >
            <span class="column-text">{{ key }}</span>
            <span class="column-value-text">{{ value }}</span>
          </div>
        </div>
        <span v-else>{{ $t('空') }}</span>
      </div>
      <div class="strip">
        <span class="label-item">{{ $t('响应体：') }}</span>
        <BodyViewer
          v-if="reResult.ok && reResultBody"
          :key="'reResult' + reResultAt"
          :raw="reResult.body"
        />
        <span v-else-if="!reResult.ok" class="re-error">
          {{ reResult.error }}
        </span>
        <span v-else>{{ $t('空') }}</span>
      </div>
    </div>
    <div
      class="content-box"
      v-if="typeof csn.statusCode === 'number'"
    >
      <template v-if="typeof csn.statusCode === 'number'">
        <div class="strip">
          <span class="label-item">{{ $t('响应时间：') }}</span>
          <span>
            {{ dayjs(csn.endTime).format('YYYY-MM-DD HH:mm:ss') }}
          </span>
        </div>
        <div class="strip">
          <span class="label-item">{{ $t('响应状态：') }}</span>
          <span>{{ csn.statusCode }}</span>
        </div>
        <div class="strip">
          <span class="label-item">{{ $t('响应头：') }}</span>
          <div
            class="headers-container"
            v-if="Object.keys(csn.resHeaders ?? {}).length !== 0"
          >
            <div
              class="row-container"
              v-for="(value, key) in csn.resHeaders"
            >
              <span class="column-text">{{ key }}</span>
              <span class="column-value-text">{{ value }}</span>
            </div>
          </div>
          <span v-else>{{ $t('空') }}</span>
        </div>
        <div class="strip">
          <span class="label-item">{{ $t('响应体：') }}</span>
          <BodyViewer
            v-if="resBody"
            :key="csn.id + 'responseBody'"
            :raw="csn.resBody"
          />
          <span v-else>空</span>
        </div>
      </template>
    </div>
  </div>
</template>
<style scoped>
.format-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 15px;
}

/* 框内顶部的操作行（靠右）。它在 content-box 内部、有 15px padding，
   所以不会超出外框 */
.detail-toolbar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  /* 抵消 content-box 的 10px gap，让按钮贴近请求地址 */
  margin-bottom: -4px;
}

/* 请求头编辑态：值和只读态用同一套列宽，视觉上就是同一个表格 */
/* 请求体下方的操作行，右对齐，和顶部工具栏呼应 */
.edit-actions-bottom {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 6px;
  padding-top: 10px;
}

.column-value-edit {
  flex: 7;
  min-width: 0;
  padding: 4px 6px;
  display: flex;
  align-items: center;
}

.edit-value-input {
  font-size: 12px;
}

.edit-textarea {
  flex: 1;
  min-width: 0;
  font-family: Monaco, Menlo, Consolas, monospace;
  font-size: 12px;
}

/* 结果块标题：不参与行结构，只是把「重发结果」和下面的原始响应区分开 */
.re-result-title {
  font-size: 12px;
  font-weight: 500;
  color: var(--color-main);
  padding-bottom: 8px;
  margin-bottom: 8px;
  border-bottom: 1px solid var(--color-scroll);
}

.re-duration {
  margin-left: 6px;
  font-size: 12px;
  opacity: 0.6;
}

.re-error {
  margin-top: 6px;
  font-size: 12px;
  color: var(--color-error);
  word-break: break-all;
}

/* 发送按钮用 primary 主题色，不能复用 .copy-params-btn
   （那个类会把文字设成 var(--color-main)，和按钮底色一样，字就看不见了） */
.send-request-btn {
  flex-shrink: 0;
  height: 24px;
  padding: 0 10px;
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.copy-params-btn {
  flex-shrink: 0;
  height: 22px;
  padding: 0 8px;
  font-size: 12px;
  color: var(--color-main);
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.copy-params-btn:hover {
  background-color: rgba(51, 102, 102, 0.1);
  color: var(--color-main);
}

.content-box {
  gap: 10px;
  display: flex;
  flex-direction: column;
  background-color: var(--color-background);
  padding: 15px;
  border-radius: var(--border-radius-large);
}

.strip {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  position: relative;
  gap: 10px;
}

.label-item {
  width: 130px;
  flex-shrink: 0;
}

.headers-container {
  display: flex;
  flex-direction: column;
  width: 100%;
  border: 1px solid var(--color-scroll);
  border-radius: var(--border-radius-large);
}

.row-container {
  display: flex;
  flex-direction: row;
  align-items: center;
  border-bottom: 1px solid var(--color-scroll);
}

.row-container:nth-last-child(1) {
  border-bottom-width: 0px;
}

.column-text {
  border-right: 1px solid var(--color-scroll);
  padding: 8px 10px;
  align-self: stretch;
  flex: 3;
  font-weight: 500;
  flex-shrink: 0;
}

.column-value-text {
  padding: 8px 10px;
  flex: 7;
  word-wrap: break-word;
  word-break: break-all;
}

.br {
  width: 100%;
  height: 1px;
  background-color: var(--color-scroll);
}

.highlight {
  flex: 1;
  border-radius: var(--border-radius-default);
}

.copy {
  position: absolute;
  right: 10px;
  top: 10px;
  cursor: pointer;
}

.req-url {
  word-wrap: break-word;
  word-break: break-all;
}

</style>
