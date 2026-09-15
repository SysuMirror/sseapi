<template>
  <div>
    <h1 class="page-title">管理台</h1>
    <p class="page-sub">
      注册 vLLM 上游、设定定价与域名限制；可开启 Claude 协议兼容转发。
    </p>

    <div class="tabs">
      <button
        v-for="t in tabs"
        :key="t.id"
        type="button"
        class="tab"
        :class="{ on: tab === t.id }"
        @click="tab = t.id"
      >
        {{ t.label }}
      </button>
    </div>

    <section v-if="tab === 'stats'" class="card panel">
      <div class="stats" v-if="stats">
        <div><span>用户</span><strong>{{ stats.users }}</strong></div>
        <div><span>有效密钥</span><strong>{{ stats.activeKeys }}</strong></div>
        <div><span>已配上游模型</span><strong>{{ stats.enabledModels }}</strong></div>
        <div><span>30 日消费</span><strong>¥{{ stats.last30d.costYuan.toFixed(2) }}</strong></div>
      </div>
      <div v-if="stats?.byModel && Object.keys(stats.byModel).length" class="by-model">
        <h4>近 30 日按模型</h4>
        <table class="table">
          <thead>
            <tr>
              <th>模型</th>
              <th>请求</th>
              <th>Tokens</th>
              <th>消费</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(v, k) in stats.byModel" :key="k">
              <td class="mono">{{ k }}</td>
              <td>{{ v.requests }}</td>
              <td class="mono">{{ v.tokens }}</td>
              <td class="mono">¥{{ (v.costCents / 100).toFixed(2) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section v-else-if="tab === 'limits'" class="card panel">
      <h3>全局限流（/v1 强校验）</h3>
      <p class="hint">
        在代理层强制 RPM 与并发上限；用户/密钥/模型可单独覆盖（0=继承默认）。超限返回 HTTP 429。
      </p>
      <form v-if="rateLimits" class="form" @submit.prevent="saveRateLimits">
        <div class="fields">
          <div class="field">
            <label>启用限流</label>
            <select v-model="rateLimits.enabled">
              <option :value="true">是</option>
              <option :value="false">否</option>
            </select>
          </div>
          <div class="field">
            <label>默认 RPM（次/分钟）</label>
            <input v-model.number="rateLimits.defaultRpm" type="number" min="0" step="1" />
            <p class="hint">0=不限制</p>
          </div>
          <div class="field">
            <label>默认最大并发</label>
            <input v-model.number="rateLimits.defaultMaxConcurrent" type="number" min="0" step="1" />
            <p class="hint">0=不限制；流式请求占用并发直至结束</p>
          </div>
        </div>
        <button class="btn btn-primary" type="submit">保存全局限流</button>
      </form>

      <div class="runtime-panel">
        <div class="row-between">
          <h4>实时并发状态</h4>
          <div class="runtime-controls">
            <label class="toggle">
              <input type="checkbox" v-model="runtimeAutoRefresh" @change="onRuntimeAutoRefresh" />
              自动刷新
            </label>
            <button class="btn btn-ghost" type="button" :disabled="runtimeLoading" @click="loadRuntimeStatus">刷新</button>
          </div>
        </div>
        <p class="hint">实时展示当前在处理中的请求（不含已完成的）。「上限 0」表示该层不限；模型并发会被名下用户/密钥的并发上限压住（三者取小）。</p>

        <div v-if="runtimeLoading && !runtime" class="muted">加载中…</div>
        <template v-else-if="runtime">
          <!-- 顶部：全局大数字 + 正在使用的用户 -->
          <div class="rt-hero">
            <div class="rt-hero-main">
              <div class="rt-hero-label">全局处理中</div>
              <div class="rt-hero-num">
                <strong>{{ runtime.global.current }}</strong>
                <span class="rt-hero-max">/ {{ runtime.global.limit || '∞' }}</span>
              </div>
              <div class="rt-hero-tag" :class="{ on: runtime.global.enabled }">
                {{ runtime.global.enabled ? '限流已开启' : '未开启限流' }}
              </div>
            </div>
            <div class="rt-hero-side">
              <div class="rt-hero-item">
                <div class="rt-hero-item-label">正在使用的用户</div>
                <div class="rt-hero-item-num">{{ activeUsers.length }}</div>
              </div>
              <div class="rt-hero-item">
                <div class="rt-hero-item-label">活跃模型</div>
                <div class="rt-hero-item-num">{{ activeModels.length }}</div>
              </div>
              <div class="rt-hero-item">
                <div class="rt-hero-item-label">活跃端点</div>
                <div class="rt-hero-item-num">{{ activeEndpoints.length }}</div>
              </div>
            </div>
          </div>

          <!-- 正在使用的用户（突出展示） -->
          <div class="rt-block" v-if="activeUsers.length">
            <div class="rt-block-title">
              <h5>正在使用的用户</h5>
              <span class="muted">当前并发中的请求</span>
            </div>
            <div class="rt-chips">
              <div v-for="u in activeUsers" :key="u.id" class="rt-chip live">
                <span class="rt-chip-dot" />
                <span class="rt-chip-name">{{ u.name }}</span>
                <span class="rt-chip-num">{{ u.current }}</span>
                <span class="rt-chip-limit">/ {{ u.limit || '∞' }}</span>
              </div>
            </div>
            <div v-if="!activeUsers.length" class="rt-empty">当前没有进行中的请求</div>
          </div>

          <!-- 活跃模型 -->
          <div class="rt-block" v-if="activeModels.length">
            <div class="rt-block-title">
              <h5>活跃模型</h5>
              <span class="muted">按当前处理数排序</span>
            </div>
            <div class="rt-models">
              <div v-for="m in activeModels" :key="m.slug" class="rt-model">
                <span class="rt-model-name mono">{{ m.slug }}</span>
                <div class="rt-model-track">
                  <div
                    class="rt-model-bar"
                    :style="{ width: modelPct(m) }"
                  />
                </div>
                <span class="rt-model-num">{{ m.current }} <span class="muted">/ {{ m.limit || '∞' }}</span></span>
              </div>
            </div>
          </div>

          <!-- 端点 + 正在使用的用户表格 -->
          <div class="runtime-grid">
            <div class="runtime-col">
              <h5>按端点</h5>
              <table class="table mini">
                <thead><tr><th>端点</th><th>当前</th></tr></thead>
                <tbody>
                  <tr v-for="e in runtime.endpoints" :key="e.name">
                    <td class="mono">{{ e.name }}</td>
                    <td><span class="dot-ind" :class="{ on: e.current > 0 }" />{{ e.current }}</td>
                  </tr>
                  <tr v-if="!runtime.endpoints.length"><td colspan="2" class="muted">无进行中的请求</td></tr>
                </tbody>
              </table>
            </div>
            <div class="runtime-col">
              <h5>正在使用的用户（含空闲）</h5>
              <table class="table mini">
                <thead><tr><th>用户</th><th>当前 / 上限</th></tr></thead>
                <tbody>
                  <tr v-for="u in runtime.users" :key="u.id" :class="u.current === 0 ? 'row-dim' : ''">
                    <td class="mono">{{ u.name }}</td>
                    <td>{{ u.current }} / {{ u.limit || '∞' }}</td>
                  </tr>
                  <tr v-if="!runtime.users.length"><td colspan="2" class="muted">无</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </template>
      </div>
    </section>

    <section v-else-if="tab === 'usage'" class="card panel">
      <div class="row-between">
        <h3>用户 Token 用量</h3>
        <div class="ru-controls">
          <select v-model.number="ruDays" class="ru-control" @change="loadUsageByUser">
            <option :value="7">近 7 天</option>
            <option :value="30">近 30 天</option>
            <option :value="90">近 90 天</option>
          </select>
          <button class="btn btn-ghost" type="button" :disabled="ruLoading" @click="loadUsageByUser">刷新</button>
        </div>
      </div>
      <p class="hint">按用户统计调用量、Token 与费用。点击某用户「查看」可下钻到该用户的调用明细（含提示词）。</p>

      <div v-if="ruLoading && !ruData" class="muted">加载中…</div>
      <template v-else-if="ruData">
        <div class="stats ru-stats">
          <div><span>用户数</span><strong>{{ ruData.byUser.length }}</strong></div>
          <div><span>总请求</span><strong>{{ formatNum(ruData.totals.request_count) }}</strong></div>
          <div><span>总 Tokens</span><strong>{{ formatNum(ruData.totals.total_tokens) }}</strong></div>
          <div><span>总消费</span><strong>¥{{ (ruData.totals.costYuan || 0).toFixed(4) }}</strong></div>
        </div>

        <div class="table-scroll">
          <table class="table" v-if="ruData.byUser.length">
            <thead>
              <tr>
                <th>用户</th>
                <th>角色</th>
                <th>请求</th>
                <th>Tokens</th>
                <th>Prompt</th>
                <th>Completion</th>
                <th>缓存</th>
                <th>费用</th>
                <th>错误</th>
                <th class="col-actions"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="u in ruData.byUser" :key="u.user_id">
                <td>
                  <div class="ru-user">{{ u.name }}</div>
                  <div class="muted small mono">#{{ u.user_id }}</div>
                </td>
                <td>
                  <span v-if="u.dev" class="role-chip" :class="roleCls(u.dev.roleLabel)">{{ u.dev.roleLabel }}</span>
                  <span v-else class="muted small">—</span>
                </td>
                <td>{{ u.requests }}</td>
                <td class="mono">{{ u.tokens.toLocaleString() }}</td>
                <td class="mono">{{ u.prompt_tokens.toLocaleString() }}</td>
                <td class="mono">{{ u.completion_tokens.toLocaleString() }}</td>
                <td class="mono">{{ u.cached_tokens.toLocaleString() }}</td>
                <td class="mono">¥{{ Number(u.costYuan || 0).toFixed(4) }}</td>
                <td :class="{ err: u.errors > 0 }">{{ u.errors }}</td>
                <td class="actions">
                  <button class="btn btn-ghost" type="button" @click="openUserDetail(u)">查看</button>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-else class="empty-inline">暂无用量记录</div>
        </div>

        <!-- 下钻明细 -->
        <div v-if="ruDetail.show" class="ru-detail">
          <div class="row-between">
            <h4>「{{ ruDetail.name }}」调用明细</h4>
            <button class="btn btn-ghost" type="button" @click="ruDetail.show = false">关闭</button>
          </div>

          <!-- 集市开发者身份 + 需求单 -->
          <div v-if="ruDetail.dev" class="ru-devbox">
            <div class="ru-devhead">
              <span class="role-chip" :class="roleCls(ruDetail.dev.roleLabel || '普通用户')">{{ ruDetail.dev.roleLabel || '普通用户' }}</span>
              <span v-if="ruDetail.dev.isDeveloper" class="muted small">集市开发者</span>
              <button v-if="ruDetail.dev && ruDetail.dev.isDeveloper && !ruDevReqs.loaded" class="btn btn-ghost small" :disabled="ruDevReqs.loading" @click="loadDevReqs">查看需求单</button>
            </div>
            <div v-if="ruDetail.dev.reqsError" class="ru-dev-no">开发者平台查询失败：{{ ruDetail.dev.reqsError }}</div>
            <div v-else-if="ruDevReqs.loaded" class="ru-devreqs">
              <div v-if="ruDevReqs.items.length" class="req-list">
                <div v-for="r in ruDevReqs.items" :key="r.id" class="req-item">
                  <div class="req-title">
                    <span class="req-stage" :class="'stage-' + stageKey(r.stage)">{{ r.stageLabel || r.stage }}</span>
                    <span class="req-name">{{ r.title }}</span>
                  </div>
                  <div class="req-meta">
                    <span v-if="r.bizName" class="muted small">{{ r.bizName }}</span>
                    <span class="muted small">优先级 {{ priorityLabel(r.priority) }}</span>
                    <span v-if="r.dueDate" class="muted small">期望 {{ fmtDate(r.dueDate) }}</span>
                  </div>
                </div>
              </div>
              <div v-else class="ru-dev-no">暂无进行中的需求单</div>
            </div>
          </div>

          <div class="filters">
            <select v-model="ruDetail.model" class="ru-control" @change="loadUsageDetail">
              <option value="">全部模型</option>
              <option v-for="m in ruModelOptions" :key="m" :value="m">{{ m }}</option>
            </select>
            <select v-model="ruDetail.status" class="ru-control" @change="loadUsageDetail">
              <option value="">全部状态</option>
              <option value="ok">成功</option>
              <option value="error">错误</option>
            </select>
          </div>
          <table class="table">
            <thead>
              <tr>
                <th>时间</th>
                <th>模型</th>
                <th>提示词</th>
                <th>Tokens</th>
                <th>费用</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in ruDetail.items" :key="r.id">
                <td>{{ fmtTime(r.created_at) }}</td>
                <td class="mono">{{ r.model_slug }}</td>
                <td class="ru-prompt" :title="(r.prompt || '')">{{ promptPreview(r.prompt) }}</td>
                <td class="mono">{{ r.total_tokens || 0 }}</td>
                <td class="mono">¥{{ Number(r.costYuan ?? 0).toFixed(4) }}</td>
                <td>
                  <span class="chip" :class="r.status === 'ok' ? 'chip-ok' : 'chip-err'">{{ r.status }}</span>
                </td>
              </tr>
              <tr v-if="!ruDetail.items.length"><td colspan="6" class="muted">暂无明细</td></tr>
            </tbody>
          </table>
          <div class="pager" v-if="ruDetail.total > ruDetail.pageSize">
            <button class="btn btn-ghost" :disabled="ruDetail.page <= 1" @click="ruDetail.page -= 1; loadUsageDetail()">上一页</button>
            <span class="muted">{{ ruDetail.page }} / {{ Math.ceil(ruDetail.total / ruDetail.pageSize) }}</span>
            <button class="btn btn-ghost" :disabled="ruDetail.page * ruDetail.pageSize >= ruDetail.total" @click="ruDetail.page += 1; loadUsageDetail()">下一页</button>
          </div>
        </div>
      </template>
    </section>

    <section v-else-if="tab === 'models'" class="card panel">
      <div class="row-between">
        <h3>模型 / vLLM 上游</h3>
        <button class="btn btn-primary" type="button" @click="openCreate">注册模型</button>
      </div>
      <p class="hint">
        Base URL 填 OpenAI 兼容根（如 <code>http://host:8000/v1</code>）。Slug 是用户调用时的
        <code>model</code> 字段；上游模型名对应 vLLM <code>--served-model-name</code>。
      </p>
      <div class="table-scroll" v-if="models.length">
        <table class="table models-table">
          <thead>
            <tr>
              <th>模型</th>
              <th>上游</th>
              <th>定价</th>
              <th>限流</th>
              <th>状态</th>
              <th class="col-actions">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in models" :key="m.id">
              <td>
                <div class="model-cell">
                  <div class="model-title">
                    <span class="model-name">{{ m.displayName }}</span>
                    <span v-if="m.badge" class="badge">{{ m.badge }}</span>
                    <span class="pill pill-type">{{ m.modelTypeLabel || m.modelType || 'chat' }}</span>
                    <span v-if="m.multimodalEnabled" class="pill pill-mm">多模态</span>
                    <span v-if="m.thinkingEnabled" class="pill pill-think">思考</span>
                    <span v-if="m.anthropicEnabled" class="pill pill-claude">Anthropic</span>
                    <span v-if="m.responsesEnabled" class="pill pill-responses">Responses</span>
                    <span v-if="m.contextLength" class="pill pill-ctx">上下文 {{ (m.contextLength).toLocaleString() }}</span>
                    <span v-if="m.devOnly" class="pill pill-dev">仅开发者</span>
                  </div>
                  <div class="mono model-slug">{{ m.slug }}</div>
                </div>
              </td>
              <td>
                <div class="upstream-cell">
                  <div
                    class="upstream-url mono"
                    :title="m.upstreamBaseUrl || ''"
                  >
                    {{ m.upstreamBaseUrl || '未配置' }}
                  </div>
                  <div class="tag-row">
                    <span v-if="m.hasUpstreamApiKey" class="pill">有密钥</span>
                    <span v-else class="pill pill-muted">无密钥</span>
                  </div>
                </div>
              </td>
              <td>
                <div class="price-grid mono">
                  <div><span>入</span>{{ formatPrice(m.inputPricePer1m) }}</div>
                  <div><span>缓存</span>{{ formatPrice(m.cachePricePer1m) }}</div>
                  <div><span>出</span>{{ formatPrice(m.outputPricePer1m) }}</div>
                  <div v-if="m.multimodalEnabled" class="price-img">
                    <span>图</span>
                    {{
                      m.imageBillingMode === 'per_image'
                        ? `¥${formatPrice(m.imagePricePerImage)}/张`
                        : m.imagePricePer1m
                          ? `${formatPrice(m.imagePricePer1m)}/1M`
                          : '随输入'
                    }}
                  </div>
                </div>
              </td>
              <td>
                <div class="limit-cell">
                  <div>{{ m.allowedOrigins?.trim() ? '限域名' : '不限域名' }}</div>
                  <div class="mono small muted">
                    RPM {{ m.rpmLimit || '默认' }} · 并发 {{ m.maxConcurrent || '默认' }}
                  </div>
                </div>
              </td>
              <td>
                <span class="status-pill" :class="m.enabled ? 'on' : 'off'">
                  {{ m.enabled ? '启用' : '停用' }}
                </span>
              </td>
              <td class="col-actions">
                <div class="actions actions-inline">
                  <button class="btn btn-ghost btn-sm" type="button" @click="openTest(m)">
                    测试
                  </button>
                  <button class="btn btn-ghost btn-sm" type="button" @click="edit(m)">编辑</button>
                  <button class="btn btn-danger btn-sm" type="button" @click="remove(m.id)">
                    删除
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="testing && !editing" class="form test-panel">
        <div class="row-between">
          <h4>连通性测试 · {{ testing.displayName || testing.slug }}</h4>
          <button class="btn btn-ghost" type="button" @click="closeTest">关闭</button>
        </div>
        <p class="hint">
          直连上游
          <code>{{ probePath(testing) }}</code
          >，不计费、不走用户 API Key。
        </p>
        <div class="fields">
          <div class="field full">
            <label>{{
              testing.modelType === 'embedding'
                ? '测试文本（多行或逗号分隔）'
                : testing.modelType === 'rerank'
                  ? '测试 query + 文档（换行分隔）'
                  : '测试 Prompt'
            }}</label>
            <textarea v-model="testPrompt" rows="2" />
          </div>
          <div class="field" v-if="(testing.modelType || 'chat') === 'chat'">
            <label>max_tokens</label>
            <input v-model.number="testMaxTokens" type="number" min="1" max="256" />
          </div>
        </div>
        <div class="actions" style="margin-top: 12px">
          <button
            class="btn btn-primary"
            type="button"
            :disabled="testBusy"
            @click="runTest(false)"
          >
            {{
              testBusy && testMode === 'json'
                ? '测试中…'
                : (testing.modelType || 'chat') === 'chat'
                  ? '非流式测试'
                  : '连通性测试'
            }}
          </button>
          <button
            v-if="(testing.modelType || 'chat') === 'chat'"
            class="btn btn-ghost"
            type="button"
            :disabled="testBusy"
            @click="runTest(true)"
          >
            {{ testBusy && testMode === 'stream' ? '测试中…' : '流式测试' }}
          </button>
        </div>
        <div v-if="testError" class="test-result fail">{{ testError }}</div>
        <div v-else-if="testResult" class="test-result" :class="testResult.ok ? 'pass' : 'fail'">
          <div class="row-between" style="margin-bottom: 8px">
            <strong>{{ testResult.ok ? '成功' : '失败' }} · {{ testResult.mode }}</strong>
            <span class="mono small"
              >HTTP {{ testResult.httpStatus }} · {{ testResult.elapsedMs }}ms</span
            >
          </div>
          <p v-if="testResult.error" class="hint" style="color: var(--danger-ink)">{{ testResult.error }}</p>
          <p class="hint mono">
            {{ testResult.upstreamUrl }} · model={{ testResult.upstreamModel }}
            <template v-if="testResult.chunkCount != null">
              · chunks={{ testResult.chunkCount }}
            </template>
            <template v-if="testResult.finishReason"> · finish={{ testResult.finishReason }}</template>
          </p>
          <p v-if="testResult.usageParsed" class="hint mono usage-line">
            <span class="usage-cap">token 检测</span>
            prompt={{ testResult.usageParsed.prompt ?? '—' }} · cached={{
              testResult.usageParsed.cached ?? '—'
            }}
            · completion={{ testResult.usageParsed.completion ?? '—' }} · total={{
              testResult.usageParsed.total ?? '—'
            }}
            <template v-if="testResult.usageParsed.reasoning">
              · 其中 reasoning={{ testResult.usageParsed.reasoning }}
            </template>
            · 来源={{ testResult.usageParsed.source === 'upstream' ? '上游 usage' : '估算' }}
            <template v-if="!testResult.usageParsed.found">
              <span class="warn">（上游未返回 usage，此值可能为估算）</span>
            </template>
          </p>
          <p v-else-if="testResult.usage" class="hint mono usage-line">
            <span class="usage-cap">token 检测</span>
            · 上游未返回可识别的 usage 字段（已回退估算）
          </p>
          <pre v-if="testResult.reasoningContent" class="test-content reasoning">
            <template>reasoning_content: {{ testResult.reasoningContent }}</template>
          </pre>
          <pre class="test-content">{{ testResult.content || '(无文本内容)' }}</pre>
          <details v-if="testResult.rawPreview || testResult.rawTail">
            <summary class="small muted">原始响应</summary>
            <div v-if="testResult.mode === 'stream'" class="raw-note">
              流式原文（含 SSE 事件）：上方为开头、下方为结尾，末尾通常有
              <code>usage</code> chunk。
            </div>
            <template v-if="testResult.rawPreview">
              <div class="small muted raw-cap">— 开头 —</div>
              <pre class="test-content">{{ testResult.rawPreview }}</pre>
            </template>
            <template v-if="testResult.rawTail">
              <div class="small muted raw-cap">— 结尾 —</div>
              <pre class="test-content">{{ testResult.rawTail }}</pre>
            </template>
            <template v-if="testResult.usageRaw">
              <div class="small muted raw-cap">— usage chunk —</div>
              <pre class="test-content">{{ testResult.usageRaw }}</pre>
            </template>
          </details>
        </div>
      </div>

      <form v-if="editing" class="form" @submit.prevent="saveModel">
        <h4>{{ editing.id ? '编辑模型' : '注册模型' }}</h4>

        <div class="preview-card" :style="{ borderTopColor: editing.cardColor || '#3370ff' }">
          <div class="preview-top">
            <strong>{{ editing.displayName || '展示名称' }}</strong>
            <span v-if="editing.badge" class="badge">{{ editing.badge }}</span>
          </div>
          <p class="preview-desc">{{ editing.description || '暂无描述' }}</p>
          <div class="preview-meta mono">
            <div><span>ID</span>{{ editing.slug || '—' }}</div>
            <div><span>输入</span>¥{{ editing.inputPricePer1m ?? 0 }}/1M</div>
            <div><span>缓存</span>¥{{ editing.cachePricePer1m ?? 0 }}/1M</div>
            <div><span>输出</span>¥{{ editing.outputPricePer1m ?? 0 }}/1M</div>
            <div v-if="editing.multimodalEnabled">
              <span>多模态</span>
              {{
                editing.imageBillingMode === 'per_image'
                  ? `¥${editing.imagePricePerImage ?? 0}/张`
                  : '按 token'
              }}
            </div>
          </div>
          <div class="preview-foot">
            <span class="muted small">用户「模型」页卡片预览</span>
            <span class="state" :class="{ on: editing.enabled }">{{
              editing.enabled ? '可用' : '已下线'
            }}</span>
          </div>
        </div>

        <div class="fields">
          <div class="field" v-if="!editing.id">
            <label>Slug（用户调用 model=）</label>
            <input v-model="editing.slug" required placeholder="qwen2-7b" />
          </div>
          <div class="field">
            <label>模型类型</label>
            <select v-model="editing.modelType">
              <option value="chat">对话 / Chat Completions</option>
              <option value="embedding">向量 / Embeddings</option>
              <option value="image_generation">生图 / Images Generations</option>
              <option value="rerank">重排序 / Rerank</option>
            </select>
          </div>
          <div class="field">
            <label>展示名称</label>
            <input v-model="editing.displayName" required />
          </div>
          <div class="field">
            <label>徽章</label>
            <input v-model="editing.badge" placeholder="vLLM" />
          </div>
          <div class="field">
            <label>卡片色</label>
            <input v-model="editing.cardColor" type="color" />
          </div>
          <div class="field full">
            <label>描述（用户卡片）</label>
            <textarea v-model="editing.description" rows="2" />
          </div>
          <div class="field full" v-if="editing.modelType === 'embedding'">
            <label>向量上游协议</label>
            <select v-model="editing.upstreamApiFormat">
              <option value="openai">OpenAI /v1/embeddings（input + model）</option>
              <option value="tei_inputs">TEI 原生 /embed（inputs）</option>
              <option value="tei_texts">TEI 变体 /embed（texts）</option>
            </select>
            <p class="hint">{{ embeddingFormatHint(editing.upstreamApiFormat) }}</p>
          </div>
          <div class="field full" v-if="editing.modelType === 'rerank'">
            <label>重排序上游协议</label>
            <select v-model="editing.upstreamApiFormat">
              <option value="openai">OpenAI 兼容 /v1/rerank</option>
              <option value="siliconflow">SiliconFlow /rerank</option>
              <option value="cohere">Cohere /v1/rerank</option>
              <option value="jina">Jina /v1/rerank</option>
              <option value="tei">本地 TEI /rerank</option>
            </select>
            <p class="hint">{{ rerankFormatHint(editing.upstreamApiFormat) }}</p>
          </div>
          <div class="field full" v-if="editing.modelType === 'embedding'">
            <label>上游路径覆盖（可选）</label>
            <input v-model="editing.upstreamPathOverride" placeholder="/embed 或留空按协议默认" />
          </div>
          <div class="field full">
            <label>{{ upstreamBaseLabel(editing) }}</label>
            <input
              v-model="editing.upstreamBaseUrl"
              :placeholder="upstreamBasePlaceholder(editing)"
              required
            />
          </div>
          <div class="field">
            <label>上游模型名（vLLM served name）</label>
            <input v-model="editing.upstreamModel" placeholder="Qwen2-7B-Instruct" />
          </div>
          <div class="field">
            <label>上游 API Key（可选）</label>
            <input
              v-model="editing.upstreamApiKey"
              type="password"
              autocomplete="new-password"
              :placeholder="editing.hasUpstreamApiKey ? '已配置，留空不修改' : '多数 vLLM 可留空'"
            />
          </div>
          <div class="field" v-if="editing.id && editing.hasUpstreamApiKey">
            <label>清空上游密钥</label>
            <label class="check">
              <input v-model="editing.clearUpstreamApiKey" type="checkbox" />
              清除已保存的密钥
            </label>
          </div>
          <div class="field">
            <label>输入价 ¥/1M tokens（未命中缓存）</label>
            <input v-model.number="editing.inputPricePer1m" type="number" step="0.001" min="0" />
          </div>
          <div class="field">
            <label>缓存价 ¥/1M tokens（命中 prompt cache）</label>
            <input v-model.number="editing.cachePricePer1m" type="number" step="0.001" min="0" />
            <p class="hint">支持细粒度如 0.001</p>
          </div>
          <div class="field">
            <label>输出价 ¥/1M tokens</label>
            <input v-model.number="editing.outputPricePer1m" type="number" step="0.001" min="0" />
          </div>
          <div class="field">
            <label>思考 / 推理（enable_thinking）</label>
            <select v-model="editing.thinkingEnabled" :disabled="editing.modelType !== 'chat'">
              <option :value="true">支持</option>
              <option :value="false">不支持</option>
            </select>
          </div>
          <div class="field" v-if="editing.thinkingEnabled && editing.modelType === 'chat'">
            <label>思考强度档位（逗号分隔）</label>
            <input
              v-model="editing.thinkingLevelsText"
              placeholder="off,low,medium,high"
            />
          </div>
          <div class="field" v-if="editing.thinkingEnabled && editing.modelType === 'chat'">
            <label>默认思考档位</label>
            <input v-model="editing.defaultThinking" placeholder="off" />
          </div>
          <div class="field full" v-if="editing.modelType === 'chat'">
            <label>Anthropic（Claude）协议开关（POST /v1/messages）</label>
            <div class="inline-input">
              <select v-model="editing.anthropicEnabled">
                <option :value="true">开启</option>
                <option :value="false">关闭</option>
              </select>
              <button
                class="btn btn-ghost"
                type="button"
                :disabled="!editing.anthropicEnabled || !editing.id || protocolTestBusy === 'anthropic'"
                @click="runProtocolTest('anthropic')"
              >
                {{ protocolTestBusy === 'anthropic' ? '测试中…' : '测试连通性' }}
              </button>
            </div>
            <p class="hint">开启后本站对外 serve <code>/v1/messages</code>。测试会探测：填了独立上游=透传是否可用；未填=反代（转 chat）链路是否连通。新增模型需先保存再测试。</p>
          </div>
          <div class="field full" v-if="editing.modelType === 'chat' && editing.anthropicEnabled">
            <label>Anthropic Base URL（独立上游，如 https://api.anthropic.com/v1）</label>
            <input
              v-model="editing.anthropicBaseUrl"
              placeholder="可选；留空则走反代（转 chat 到 OpenAI 上游）"
            />
            <p class="hint" v-if="!editing.anthropicBaseUrl">未填独立 Base URL 时，请求将反代（转 chat 到 OpenAI 上游）。</p>
            <div v-if="protocolResult.anthropic" class="protocol-test-result" :class="protocolResult.anthropic.supported ? 'ok' : 'err'">
              <strong :class="protocolResult.anthropic.supported ? 'ok' : 'warn'">
                {{ protocolResult.anthropic.supported
                  ? (protocolResult.anthropic.viaRelay ? '✔ 反代链路可用（转 chat 打得通）' : '✔ 上游原生支持（可透传）')
                  : '✘ 不可用' }}
              </strong>
              <span class="mono small">{{ protocolResult.anthropic.message }}</span>
              <span class="muted small">HTTP {{ protocolResult.anthropic.httpStatus }} · {{ protocolResult.anthropic.elapsedMs }}ms</span>
            </div>
          </div>
          <div class="field full" v-if="editing.modelType === 'chat'">
            <label>Responses 协议开关（POST /v1/responses）</label>
            <div class="inline-input">
              <select v-model="editing.responsesEnabled">
                <option :value="true">开启</option>
                <option :value="false">关闭</option>
              </select>
              <button
                class="btn btn-ghost"
                type="button"
                :disabled="!editing.responsesEnabled || !editing.id || protocolTestBusy === 'responses'"
                @click="runProtocolTest('responses')"
              >
                {{ protocolTestBusy === 'responses' ? '测试中…' : '测试连通性' }}
              </button>
            </div>
            <p class="hint">开启后本站对外 serve <code>/v1/responses</code>。测试会探测：填了独立上游=透传是否可用；未填=反代（转 chat）链路是否连通。新增模型需先保存再测试。</p>
          </div>
          <div class="field full" v-if="editing.modelType === 'chat' && editing.responsesEnabled">
            <label>Responses Base URL（独立上游，如 https://api.openai.com/v1）</label>
            <input
              v-model="editing.responsesBaseUrl"
              placeholder="可选；留空则走反代（转 chat 到 OpenAI 上游）"
            />
            <p class="hint" v-if="!editing.responsesBaseUrl">未填独立 Base URL 时，请求将反代（转 chat 到 OpenAI 上游）。</p>
            <div v-if="protocolResult.responses" class="protocol-test-result" :class="protocolResult.responses.supported ? 'ok' : 'err'">
              <strong :class="protocolResult.responses.supported ? 'ok' : 'warn'">
                {{ protocolResult.responses.supported
                  ? (protocolResult.responses.viaRelay ? '✔ 反代链路可用（转 chat 打得通）' : '✔ 上游原生支持（可透传）')
                  : '✘ 不可用' }}
              </strong>
              <span class="mono small">{{ protocolResult.responses.message }}</span>
              <span class="muted small">HTTP {{ protocolResult.responses.httpStatus }} · {{ protocolResult.responses.elapsedMs }}ms</span>
            </div>
          </div>
          <div class="field" v-if="editing.modelType === 'chat'">
            <label>多模态（接受 image_url）</label>
            <select v-model="editing.multimodalEnabled">
              <option :value="true">开启</option>
              <option :value="false">关闭</option>
            </select>
          </div>
          <div class="field" v-if="editing.modelType === 'chat' && editing.multimodalEnabled">
            <label>图片计费方式</label>
            <select v-model="editing.imageBillingMode">
              <option value="token">按 token（计入 prompt）</option>
              <option value="per_image">按张数</option>
            </select>
          </div>
          <div class="field" v-if="editing.modelType === 'chat' && editing.multimodalEnabled && editing.imageBillingMode === 'token'">
            <label>图片 token 价 ¥/1M（0=与输入价相同，不单独拆）</label>
            <input v-model.number="editing.imagePricePer1m" type="number" step="0.001" min="0" />
          </div>
          <div
            class="field"
            v-if="editing.modelType === 'chat' && editing.multimodalEnabled && editing.imageBillingMode === 'per_image'"
          >
            <label>图片单价 ¥/张</label>
            <input v-model.number="editing.imagePricePerImage" type="number" step="0.001" min="0" />
          </div>
          <div
            class="field"
            v-if="editing.modelType === 'chat' && editing.multimodalEnabled && editing.imageBillingMode === 'per_image'"
          >
            <label>每图从 prompt 扣除的预估 tokens（防双重计费）</label>
            <input v-model.number="editing.imageTokensPerImage" type="number" step="1" min="0" />
          </div>
          <div class="field" v-if="editing.modelType === 'image_generation'">
            <label>生图单价 ¥/张</label>
            <input v-model.number="editing.imagePricePerImage" type="number" step="0.001" min="0" />
            <p class="hint">优先按张计费；为 0 时按输出 token 价计费</p>
          </div>
          <div class="field">
            <label>排序</label>
            <input v-model.number="editing.sortOrder" type="number" />
          </div>
          <div class="field">
            <label>启用</label>
            <select v-model="editing.enabled">
              <option :value="true">是</option>
              <option :value="false">否</option>
            </select>
          </div>
          <div class="field">
            <label>仅对集市开发者可见</label>
            <select v-model="editing.devOnly">
              <option :value="true">是</option>
              <option :value="false">否</option>
            </select>
            <p class="hint">开启后该模型只对「集市开发者」展示与允许调用，普通用户不可见/不可调用（管理员恒可见）。仅在有对接开发者平台时生效。</p>
          </div>
          <div class="field full">
            <label>允许域名（可选，浏览器 Origin/Referer；一行一个或逗号分隔）</label>
            <textarea
              v-model="editing.allowedOrigins"
              rows="3"
              placeholder="https://app.example.com&#10;*.ssemarket.cn"
            />
            <p class="hint">留空=不限制。服务端无 Origin 的调用始终放行。</p>
          </div>
          <div class="field">
            <label>模型 RPM（0=默认）</label>
            <input v-model.number="editing.rpmLimit" type="number" min="0" step="1" />
          </div>
          <div class="field">
            <label>模型最大并发（0=默认）</label>
            <input v-model.number="editing.maxConcurrent" type="number" min="0" step="1" />
          </div>
          <div class="field" v-if="editing.modelType === 'chat'">
            <label>上下文长度（tokens，0=不限制）</label>
            <input v-model.number="editing.contextLength" type="number" min="0" step="1" placeholder="如 131072" />
            <p class="hint">>0 时，调用前检测输入是否超限，超出则拒绝（防止用户输入超限）。</p>
          </div>
        </div>

        <div class="test-inline">
          <h4>测试 API 可用性</h4>
          <p class="hint">
            用上方 Base URL / 模型名 / Key 直连上游
            <code>{{ probePath(editing) }}</code>
            探测（未保存也可测）。<template v-if="(editing.modelType || 'chat') === 'chat'">流式与非流式各测一次更稳妥。</template>
          </p>
          <div class="fields">
            <div class="field full">
              <label>{{
                editing.modelType === 'embedding'
                  ? '测试文本（多行或逗号分隔）'
                  : editing.modelType === 'image_generation'
                    ? '图片描述 Prompt'
                    : editing.modelType === 'rerank'
                      ? '测试 query + 文档（换行分隔）'
                      : '测试 Prompt'
              }}</label>
              <textarea v-model="testPrompt" rows="2" />
            </div>
            <div class="field" v-if="(editing.modelType || 'chat') === 'chat'">
              <label>max_tokens</label>
              <input v-model.number="testMaxTokens" type="number" min="1" max="256" />
            </div>
          </div>
          <div class="actions" style="margin-top: 12px">
            <button
              class="btn btn-primary"
              type="button"
              :disabled="testBusy"
              @click="runFormTest(false)"
            >
              {{
                testBusy && testMode === 'json'
                  ? '测试中…'
                  : (editing.modelType || 'chat') === 'chat'
                    ? '非流式测试'
                    : '连通性测试'
              }}
            </button>
            <button
              v-if="(editing.modelType || 'chat') === 'chat'"
              class="btn btn-ghost"
              type="button"
              :disabled="testBusy"
              @click="runFormTest(true)"
            >
              {{ testBusy && testMode === 'stream' ? '测试中…' : '流式测试' }}
            </button>
          </div>
          <div v-if="testError" class="test-result fail">{{ testError }}</div>
          <div v-else-if="testResult" class="test-result" :class="testResult.ok ? 'pass' : 'fail'">
            <div class="row-between" style="margin-bottom: 8px">
              <strong>{{ testResult.ok ? '成功' : '失败' }} · {{ testResult.mode }}</strong>
              <span class="mono small"
                >HTTP {{ testResult.httpStatus }} · {{ testResult.elapsedMs }}ms</span
              >
            </div>
            <p v-if="testResult.error" class="hint" style="color: var(--danger-ink)">{{ testResult.error }}</p>
            <p class="hint mono">
              {{ testResult.upstreamUrl }} · model={{ testResult.upstreamModel }}
              <template v-if="testResult.chunkCount != null">
                · chunks={{ testResult.chunkCount }}
              </template>
              <template v-if="testResult.finishReason">
                · finish={{ testResult.finishReason }}
              </template>
            </p>
            <p v-if="testResult.usageParsed" class="hint mono usage-line">
              <span class="usage-cap">token 检测</span>
              prompt={{ testResult.usageParsed.prompt ?? '—' }} · cached={{
                testResult.usageParsed.cached ?? '—'
              }}
              · completion={{ testResult.usageParsed.completion ?? '—' }} · total={{
                testResult.usageParsed.total ?? '—'
              }}
              <template v-if="testResult.usageParsed.reasoning">
                · 其中 reasoning={{ testResult.usageParsed.reasoning }}
              </template>
              · 来源={{ testResult.usageParsed.source === 'upstream' ? '上游 usage' : '估算' }}
              <template v-if="!testResult.usageParsed.found">
                <span class="warn">（上游未返回 usage，此值可能为估算）</span>
              </template>
            </p>
            <p v-else-if="testResult.usage" class="hint mono usage-line">
              <span class="usage-cap">token 检测</span>
              · 上游未返回可识别的 usage 字段（已回退估算）
            </p>
            <pre v-if="testResult.reasoningContent" class="test-content reasoning">
              <template>reasoning_content: {{ testResult.reasoningContent }}</template>
            </pre>
            <pre class="test-content">{{ testResult.content || '(无文本内容)' }}</pre>
            <details v-if="testResult.rawPreview || testResult.rawTail">
              <summary class="small muted">原始响应</summary>
              <div v-if="testResult.mode === 'stream'" class="raw-note">
                流式原文（含 SSE 事件）：上方为开头、下方为结尾，末尾通常有
                <code>usage</code> chunk。
              </div>
              <template v-if="testResult.rawPreview">
                <div class="small muted raw-cap">— 开头 —</div>
                <pre class="test-content">{{ testResult.rawPreview }}</pre>
              </template>
              <template v-if="testResult.rawTail">
                <div class="small muted raw-cap">— 结尾 —</div>
                <pre class="test-content">{{ testResult.rawTail }}</pre>
              </template>
              <template v-if="testResult.usageRaw">
                <div class="small muted raw-cap">— usage chunk —</div>
                <pre class="test-content">{{ testResult.usageRaw }}</pre>
              </template>
            </details>
          </div>
        </div>

        <div class="actions" style="margin-top: 16px">
          <button class="btn btn-primary" type="submit">保存</button>
          <button class="btn btn-ghost" type="button" @click="cancelEdit">取消</button>
        </div>
      </form>
    </section>

    <section v-else-if="tab === 'users'" class="card panel">
      <div class="row-between">
        <h3>用户与额度</h3>
        <input
          v-model="q"
          class="search"
          placeholder="搜索姓名 / 邮箱 / oauthId"
          @keyup.enter="loadUsers"
        />
      </div>
      <table class="table" v-if="users.length">
        <thead>
          <tr>
            <th>ID</th>
            <th>用户</th>
            <th>余额</th>
            <th>限流</th>
            <th>角色</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="u in users" :key="u.id">
            <td>{{ u.id }}</td>
            <td>
              <div>{{ u.name }}</div>
              <div class="muted small mono">{{ u.oauthId }}</div>
              <div v-if="u.adminNote" class="muted small">{{ u.adminNote }}</div>
            </td>
            <td class="mono">¥{{ (u.balanceCents / 100).toFixed(2) }}</td>
            <td class="mono small">{{ u.rpmLimit || '默认' }} / {{ u.maxConcurrent || '默认' }}</td>
            <td>{{ u.isAdmin ? '管理员' : '用户' }}</td>
            <td class="actions">
              <button class="btn btn-ghost" type="button" @click="editLimits(u)">限流</button>
              <button class="btn btn-ghost" type="button" @click="credit(u)">增减</button>
              <button class="btn btn-ghost" type="button" @click="setBalance(u)">设定余额</button>
              <button class="btn btn-ghost" type="button" @click="toggleAdmin(u)">
                {{ u.isAdmin ? '取消管理员' : '设为管理员' }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <section v-else class="card panel">
      <h3>文档跳转（iWiki）</h3>
      <p class="hint">
        平台内不再维护 Markdown。侧栏「文档」与快捷入口会打开下方链接（默认学院
        iWiki 空间）。
      </p>
      <div class="field">
        <label>显示标题</label>
        <input v-model="docTitle" placeholder="API 文档" />
      </div>
      <div class="field" style="margin-top: 10px">
        <label>跳转链接</label>
        <input
          v-model="docUrl"
          class="mono"
          placeholder="https://ssemarket.cn/iwiki/space/space-R0M8mXw2"
        />
      </div>
      <div class="actions" style="margin-top: 14px">
        <button class="btn btn-primary" type="button" @click="saveDocs">保存</button>
        <a
          class="btn btn-ghost"
          :href="docUrl || '#'"
          target="_blank"
          rel="noopener noreferrer"
        >
          打开预览
        </a>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { api } from '../api'

const tabs = [
  { id: 'stats', label: '总览' },
  { id: 'limits', label: '限流' },
  { id: 'usage', label: '用户用量' },
  { id: 'models', label: '模型' },
  { id: 'users', label: '用户' },
  { id: 'docs', label: '文档' },
] as const

const tab = ref<(typeof tabs)[number]['id']>('stats')
const stats = ref<any>(null)
const models = ref<any[]>([])
const users = ref<any[]>([])
const q = ref('')
const editing = ref<any>(null)
const testing = ref<any>(null)
const testPrompt = ref('你好，请用一句话介绍你自己。')
const testMaxTokens = ref(64)
const testBusy = ref(false)
const testMode = ref<'json' | 'stream' | null>(null)
const testResult = ref<any>(null)
const testError = ref('')
const protocolTestBusy = ref<'anthropic' | 'responses' | null>(null)
const protocolResult = ref<{
  anthropic?: any
  responses?: any
}>({})
const docTitle = ref('API 文档')
const docUrl = ref('https://ssemarket.cn/iwiki/space/space-R0M8mXw2')
const rateLimits = ref<{ enabled: boolean; defaultRpm: number; defaultMaxConcurrent: number } | null>(
  null,
)
const runtime = ref<any>(null)
const runtimeLoading = ref(false)
const runtimeAutoRefresh = ref(true)
let runtimeTimer: ReturnType<typeof setInterval> | null = null

function onRuntimeAutoRefresh() {
  if (runtimeAutoRefresh.value) {
    loadRuntimeStatus()
  }
}

async function loadRuntimeStatus() {
  if (runtimeLoading.value) return
  runtimeLoading.value = true
  try {
    runtime.value = await api.adminRateLimitsStatus()
  } catch (e) {
    runtime.value = null
  } finally {
    runtimeLoading.value = false
  }
}

// —— 实时并发：计算属性 ——
const activeUsers = computed(() => runtime.value?.activeUsers || [])
const activeModels = computed(() =>
  (runtime.value?.models || []).filter((m: any) => m.current > 0).sort((a: any, b: any) => b.current - a.current),
)
const activeEndpoints = computed(() =>
  (runtime.value?.endpoints || []).filter((e: any) => e.current > 0),
)
function modelPct(m: any): string {
  const limit = Number(m.limit) || 0
  const cur = Number(m.current) || 0
  if (limit <= 0) return Math.min(100, Math.max(8, cur * 10)) + '%'
  return Math.min(100, Math.max(8, (cur / Math.max(1, limit)) * 100)) + '%'
}

// —— 用户用量面板 ——
const ruData = ref<any>(null)
const ruDays = ref(30)
const ruLoading = ref(false)
const ruDetail = ref<{
  show: boolean
  userId: number
  name: string
  page: number
  pageSize: number
  total: number
  items: any[]
  model: string
  status: string
  dev: { isDeveloper: boolean; isAdminDev: boolean; roleLabel: string; developerUserId: number | null; reqsError: string | null } | null
}>({ show: false, userId: 0, name: '', page: 1, pageSize: 50, total: 0, items: [], model: '', status: '', dev: null })
const ruDevReqs = ref<{ loaded: boolean; loading: boolean; items: any[]; total: number }>({ loaded: false, loading: false, items: [], total: 0 })
const ruModelOptions = ref<string[]>([])

async function loadUsageByUser() {
  if (ruLoading.value) return
  ruLoading.value = true
  try {
    const res = await api.usageByUser({ days: ruDays.value })
    ruData.value = res
    const typ = new Set<string>()
    for (const m of res?.byModel || []) typ.add(m.model_slug)
    if (!ruModelOptions.value.length) {
      try {
        const models = await api.models()
        ruModelOptions.value = models.map((x: any) => x.slug)
      } catch {
        ruModelOptions.value = [...typ]
      }
    }
  } catch (e) {
    ruData.value = null
  } finally {
    ruLoading.value = false
  }
}

function openUserDetail(u: any) {
  ruDetail.value = {
    show: true,
    userId: u.user_id,
    name: u.name,
    page: 1,
    pageSize: 50,
    total: 0,
    items: [],
    model: '',
    status: '',
    dev: u.dev || null,
  }
  ruDevReqs.value = { loaded: false, loading: false, items: [], total: 0 }
  if (u.dev?.isDeveloper) loadDevReqs()
  loadUsageDetail()
}

async function loadDevReqs() {
  if (ruDevReqs.value.loaded || ruDevReqs.value.loading) return
  ruDevReqs.value.loading = true
  try {
    const res = await api.usageUserReqs(ruDetail.value.userId)
    ruDetail.value.dev = {
      isDeveloper: res?.isDeveloper || false,
      isAdminDev: res?.isAdmin || false,
      roleLabel: res?.roleLabel || (res?.isDeveloper ? '开发者' : '普通用户'),
      developerUserId: res?.userId || null,
      reqsError: res?.reqsError || null,
    }
    ruDevReqs.value.items = res?.reqs?.items || []
    ruDevReqs.value.total = res?.reqs?.total || 0
    ruDevReqs.value.loaded = true
  } catch {
    if (ruDetail.value.dev) ruDetail.value.dev.reqsError = String('加载失败')
    ruDevReqs.value.loaded = true
  } finally {
    ruDevReqs.value.loading = false
  }
}

async function loadUsageDetail() {
  const d = ruDetail.value
  const res = await api.usageLogs({
    days: ruDays.value,
    userId: d.userId,
    model: d.model,
    status: d.status,
    page: d.page,
    page_size: d.pageSize,
  })
  d.items = res?.items || []
  d.total = res?.total || 0
  d.pageSize = res?.pageSize || 50
}

function promptPreview(p: string): string {
  const s = String(p || '')
  if (s.length <= 80) return s || '—'
  return s.slice(0, 80) + '…'
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString()
}

function fmtDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString()
}

function roleCls(label: string): string {
  if (label === '管理员') return 'role-admin'
  if (label === '开发者') return 'role-dev'
  return 'role-user'
}

function priorityLabel(p: number): string {
  const n = Number(p)
  if (n <= 1) return '高'
  if (n === 2) return '中'
  if (n === 3) return '低'
  return '—'
}

function stageKey(stage: string): string {
  const s = String(stage || '').toLowerCase()
  if (s.includes('review') || s.includes('评审') || s.includes('需求')) return 'review'
  if (s.includes('dev') || s.includes('开发')) return 'dev'
  if (s.includes('deploy') || s.includes('发布')) return 'deploy'
  return 'other'
}

function formatNum(n?: number) {
  if (n == null) return '0'
  return n.toLocaleString()
}

async function loadStats() {
  stats.value = await api.adminStats()
}
async function loadModels() {
  models.value = await api.adminModels()
}

function formatPrice(v: unknown) {
  const n = Number(v)
  if (!Number.isFinite(n)) return '0'
  // 保留有效小数，去掉多余 0（0.001 / 1 / 2.5）
  return String(parseFloat(n.toFixed(6)))
}

function probePath(m: { modelType?: string; upstreamApiFormat?: string; upstreamPathOverride?: string }) {
  const t = m?.modelType || 'chat'
  if (t === 'embedding') {
    const fmt = m.upstreamApiFormat || 'openai'
    if (m.upstreamPathOverride?.trim()) return m.upstreamPathOverride.trim()
    if (fmt === 'openai') return '/embeddings'
    return '/embed'
  }
  if (t === 'image_generation') return '/images/generations'
  if (t === 'rerank') {
    if (m.upstreamPathOverride?.trim()) return m.upstreamPathOverride.trim()
    return (m.upstreamApiFormat || 'openai') === 'tei' ? '/rerank' : '/v1/rerank'
  }
  return '/chat/completions'
}

function embeddingFormatHint(fmt: string) {
  if (fmt === 'tei_texts') {
    return '如 http://ssemarket.cn:23011，上游 POST /embed {"texts":["..."]}'
  }
  if (fmt === 'tei_inputs') {
    return '如 http://host:8080，上游 POST /embed {"inputs":"..."} 或 {"inputs":[...]}'
  }
  return '如 http://host:8080/v1，上游 POST /embeddings {"model":"...","input":"..."}'
}

function rerankFormatHint(fmt: string) {
  if (fmt === 'siliconflow') return '如 https://api.siliconflow.cn/v1，POST /rerank {"model","query","documents"}'
  if (fmt === 'cohere') return '如 https://api.cohere.com/v1，POST /rerank（返回 meta.billed_units）'
  if (fmt === 'jina') return '如 https://api.jina.ai/v1，POST /rerank（返回 usage.total_tokens）'
  if (fmt === 'tei') return '如 http://host:8801（不含 /v1），POST /rerank {"query","texts"}'
  return '如 http://host:8000/v1，POST /rerank {"model","query","documents"}'
}

function rerankProbePath(m: { upstreamApiFormat?: string; upstreamPathOverride?: string }) {
  if (m.upstreamPathOverride?.trim()) return m.upstreamPathOverride.trim()
  return m.upstreamApiFormat === 'tei' ? '/rerank' : '/v1/rerank'
}

function upstreamBaseLabel(m: { modelType?: string; upstreamApiFormat?: string }) {
  if (m.modelType === 'embedding' && m.upstreamApiFormat !== 'openai') {
    return '上游 Base URL（服务根，不含 /v1）'
  }
  if ((m.modelType === 'rerank' && (m.upstreamApiFormat || 'openai') === 'tei')) {
    return '上游 Base URL（服务根，不含 /v1）'
  }
  return '上游 Base URL（OpenAI 兼容，含 /v1）'
}

function upstreamBasePlaceholder(m: { modelType?: string; upstreamApiFormat?: string }) {
  if (m.modelType === 'embedding' && m.upstreamApiFormat !== 'openai') {
    return 'http://ssemarket.cn:23011'
  }
  if (m.modelType === 'rerank' && (m.upstreamApiFormat || 'openai') === 'tei') {
    return 'http://127.0.0.1:8801'
  }
  return 'http://127.0.0.1:8000/v1'
}
async function loadUsers() {
  users.value = await api.adminUsers(q.value)
}
async function loadDocs() {
  const d = await api.adminDocs()
  docTitle.value = d.title || 'API 文档'
  docUrl.value = d.externalUrl || 'https://ssemarket.cn/iwiki/space/space-R0M8mXw2'
}
async function loadRateLimits() {
  rateLimits.value = await api.adminRateLimits()
}

function stopRuntimePolling() {
  if (runtimeTimer) {
    clearInterval(runtimeTimer)
    runtimeTimer = null
  }
}

watch(tab, (t) => {
  if (t === 'stats') loadStats()
  if (t === 'limits') {
    loadRateLimits()
    loadRuntimeStatus()
    stopRuntimePolling()
    runtimeTimer = setInterval(() => {
      if (runtimeAutoRefresh.value) loadRuntimeStatus()
    }, 2000)
  } else {
    stopRuntimePolling()
  }
  if (t === 'usage') loadUsageByUser()
  if (t === 'models') loadModels()
  if (t === 'users') loadUsers()
  if (t === 'docs') loadDocs()
})

watch(
  () => editing.value?.modelType,
  (t) => {
    if (!editing.value) return
    if (t === 'embedding') {
      testPrompt.value = '你好世界\nhello world'
    } else if (t === 'image_generation') {
      testPrompt.value = 'a cute cat sitting on a windowsill'
    } else if (t === 'rerank') {
      testPrompt.value = '苹果\n香蕉\n猕猴桃\n西瓜'
    } else {
      testPrompt.value = '你好，请用一句话介绍你自己。'
    }
  },
)

function openCreate() {
  closeTest()
  testResult.value = null
  testError.value = ''
  protocolResult.value = {}
  editing.value = {
    slug: '',
    displayName: '',
    description: '',
    badge: 'vLLM',
    cardColor: '#3370ff',
    modelType: 'chat',
    upstreamApiFormat: 'openai',
    upstreamPathOverride: '',
    upstreamBaseUrl: '',
    upstreamModel: '',
    upstreamApiKey: '',
    allowedOrigins: '',
    hasUpstreamApiKey: false,
    clearUpstreamApiKey: false,
    inputPricePer1m: 1,
    cachePricePer1m: 0.1,
    outputPricePer1m: 2,
    multimodalEnabled: false,
    imageBillingMode: 'token',
    imagePricePer1m: 0,
    imagePricePerImage: 0.01,
    imageTokensPerImage: 512,
    thinkingEnabled: false,
    thinkingLevelsText: 'off,low,medium,high',
    defaultThinking: 'off',
    anthropicBaseUrl: '',
    anthropicEnabled: false,
    responsesBaseUrl: '',
    responsesEnabled: false,
    enabled: true,
    sortOrder: 0,
    rpmLimit: 0,
    maxConcurrent: 0,
    contextLength: 0,
    devOnly: false,
  }
}

function edit(m: any) {
  closeTest()
  testResult.value = null
  testError.value = ''
  protocolResult.value = {}
  editing.value = {
    ...m,
    thinkingLevelsText: Array.isArray(m.thinkingLevels)
      ? m.thinkingLevels.join(',')
      : String(m.thinkingLevels || 'off,low,medium,high'),
    upstreamApiKey: '',
    clearUpstreamApiKey: false,
  }
}

async function saveModel() {
  const b = editing.value
  const body = {
    displayName: b.displayName,
    description: b.description,
    badge: b.badge,
    cardColor: b.cardColor,
    modelType: b.modelType || 'chat',
    upstreamApiFormat: b.upstreamApiFormat || 'openai',
    upstreamPathOverride: b.upstreamPathOverride || '',
    upstreamBaseUrl: b.upstreamBaseUrl,
    upstreamModel: b.upstreamModel,
    upstreamApiKey: b.upstreamApiKey,
    clearUpstreamApiKey: !!b.clearUpstreamApiKey,
    allowedOrigins: b.allowedOrigins,
    inputPricePer1m: b.inputPricePer1m,
    cachePricePer1m: b.cachePricePer1m ?? 0,
    outputPricePer1m: b.outputPricePer1m,
    multimodalEnabled: !!b.multimodalEnabled,
    imageBillingMode: b.imageBillingMode === 'per_image' ? 'per_image' : 'token',
    imagePricePer1m: b.imagePricePer1m ?? 0,
    imagePricePerImage: b.imagePricePerImage ?? 0,
    imageTokensPerImage: b.imageTokensPerImage ?? 512,
    thinkingEnabled: !!b.thinkingEnabled,
    thinkingLevels: b.thinkingLevelsText,
    defaultThinking: b.defaultThinking || 'off',
    anthropicBaseUrl: b.anthropicBaseUrl || '',
    anthropicEnabled: !!b.anthropicEnabled,
    responsesBaseUrl: b.responsesBaseUrl || '',
    responsesEnabled: !!b.responsesEnabled,
    enabled: b.enabled,
    sortOrder: b.sortOrder,
    slug: b.slug,
    rpmLimit: b.rpmLimit ?? 0,
    maxConcurrent: b.maxConcurrent ?? 0,
    contextLength: b.contextLength ?? 0,
    devOnly: !!b.devOnly,
  }
  if (b.id) {
    await api.adminUpdateModel(b.id, body)
  } else {
    await api.adminCreateModel(body)
  }
  editing.value = null
  await loadModels()
}

async function remove(id: number) {
  if (!confirm('确认删除该模型？')) return
  await api.adminDeleteModel(id)
  if (testing.value?.id === id) closeTest()
  await loadModels()
}

function openTest(m: any) {
  editing.value = null
  testing.value = m
  testResult.value = null
  testError.value = ''
  testMode.value = null
  if (m.modelType === 'embedding') {
    testPrompt.value = '你好世界\nhello world'
  } else if (m.modelType === 'image_generation') {
    testPrompt.value = 'a cute cat sitting on a windowsill'
  } else if (m.modelType === 'rerank') {
    testPrompt.value = '苹果\n香蕉\n猕猴桃\n西瓜'
  }
}

function cancelEdit() {
  editing.value = null
  testResult.value = null
  testError.value = ''
}

function closeTest() {
  testing.value = null
  testResult.value = null
  testError.value = ''
  testMode.value = null
  testBusy.value = false
}

async function runProtocolTest(protocol: 'anthropic' | 'responses') {
  const b = editing.value
  if (!b?.id || protocolTestBusy.value) return
  if (protocol === 'anthropic' && !b.anthropicEnabled) return
  if (protocol === 'responses' && !b.responsesEnabled) return
  protocolTestBusy.value = protocol
  try {
    const baseUrl = protocol === 'anthropic' ? b.anthropicBaseUrl : b.responsesBaseUrl
    const result = await api.adminTestProtocol(b.id, {
      protocol,
      baseUrl: baseUrl || undefined,
      upstreamModel: b.upstreamModel || undefined,
      apiKey: b.upstreamApiKey || undefined,
    })
    protocolResult.value = { ...protocolResult.value, [protocol]: result }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    protocolResult.value = {
      ...protocolResult.value,
      [protocol]: {
        ok: false,
        supported: false,
        mode: 'relay',
        viaRelay: false,
        httpStatus: 0,
        elapsedMs: 0,
        message: msg,
        rawPreview: '',
      },
    }
  } finally {
    protocolTestBusy.value = null
  }
}

async function runTest(stream: boolean) {
  const m = testing.value
  if (!m?.id || testBusy.value) return
  testBusy.value = true
  testMode.value = stream ? 'stream' : 'json'
  testResult.value = null
  testError.value = ''
  try {
    testResult.value = await api.adminTestModel(m.id, {
      stream,
      prompt: testPrompt.value,
      maxTokens: testMaxTokens.value,
      modelType: m.modelType,
      upstreamApiFormat: m.upstreamApiFormat,
      upstreamPathOverride: m.upstreamPathOverride,
    })
  } catch (e) {
    testError.value = e instanceof Error ? e.message : String(e)
  } finally {
    testBusy.value = false
  }
}

async function runFormTest(stream: boolean) {
  const b = editing.value
  if (!b || testBusy.value) return
  if (!String(b.upstreamBaseUrl || '').trim()) {
    testError.value = '请先填写上游 Base URL'
    return
  }
  const modelName = String(b.upstreamModel || b.slug || '').trim()
  if (!modelName) {
    testError.value = '请填写上游模型名或 Slug'
    return
  }
  testBusy.value = true
  testMode.value = stream ? 'stream' : 'json'
  testResult.value = null
  testError.value = ''
  try {
    const body = {
      stream,
      prompt: testPrompt.value,
      maxTokens: testMaxTokens.value,
      upstreamBaseUrl: b.upstreamBaseUrl,
      upstreamModel: modelName,
      modelType: b.modelType,
      upstreamApiFormat: b.upstreamApiFormat,
      upstreamPathOverride: b.upstreamPathOverride,
      ...(b.upstreamApiKey ? { upstreamApiKey: b.upstreamApiKey } : {}),
    }
    testResult.value = b.id
      ? await api.adminTestModel(b.id, body)
      : await api.adminTestModel(body)
  } catch (e) {
    testError.value = e instanceof Error ? e.message : String(e)
  } finally {
    testBusy.value = false
  }
}

async function credit(u: any) {
  const raw = window.prompt(`给 ${u.name} 增减金额（元，负数为扣减）`, '10')
  if (raw == null) return
  const amountYuan = Number(raw)
  if (!Number.isFinite(amountYuan) || amountYuan === 0) return
  const note = window.prompt('备注', '管理员充值') || '管理员充值'
  await api.adminCredit(u.id, amountYuan, note)
  await loadUsers()
}

async function setBalance(u: any) {
  const cur = (u.balanceCents / 100).toFixed(2)
  const raw = window.prompt(`将 ${u.name} 余额设定为（元）`, cur)
  if (raw == null) return
  const balanceYuan = Number(raw)
  if (!Number.isFinite(balanceYuan) || balanceYuan < 0) return
  const note = window.prompt('备注', '管理员设定余额') || '管理员设定余额'
  await api.adminSetBalance(u.id, balanceYuan, note)
  await loadUsers()
}

async function toggleAdmin(u: any) {
  await api.adminSetAdmin(u.id, !u.isAdmin)
  await loadUsers()
}

async function editLimits(u: any) {
  const rpm = window.prompt(`${u.name} 的 RPM（0=继承平台默认）`, String(u.rpmLimit || 0))
  if (rpm == null) return
  const conc = window.prompt(`${u.name} 的最大并发（0=继承平台默认）`, String(u.maxConcurrent || 0))
  if (conc == null) return
  await api.adminPatchUser(u.id, {
    rpmLimit: Number(rpm) || 0,
    maxConcurrent: Number(conc) || 0,
  })
  await loadUsers()
}

async function saveRateLimits() {
  if (!rateLimits.value) return
  await api.adminSaveRateLimits(rateLimits.value)
  alert('全局限流已保存')
}

async function saveDocs() {
  const url = docUrl.value.trim()
  if (!url) {
    alert('请填写跳转链接')
    return
  }
  await api.adminSaveDocs(docTitle.value.trim() || 'API 文档', url)
  alert('已保存')
}

onMounted(loadStats)
</script>

<style scoped>
.tabs {
  display: flex;
  gap: 6px;
  margin-bottom: var(--sp-4);
  flex-wrap: wrap;
  padding: 4px;
  background: var(--n-75);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  width: fit-content;
}
.tab {
  border: 1px solid transparent;
  background: transparent;
  border-radius: var(--radius-sm);
  padding: 8px 16px;
  font-weight: 600;
  font-size: var(--fs-base);
  color: var(--ink-soft);
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease);
}
.tab:hover {
  color: var(--ink);
  background: rgba(255, 255, 255, 0.7);
}
.tab.on {
  background: var(--n-0);
  color: var(--brand-ink);
  box-shadow: var(--shadow-sm);
}
.panel {
  padding: var(--sp-5);
}
.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--sp-3);
}
.stats > div {
  padding: var(--sp-4);
  background: var(--n-25);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
}
.stats span {
  display: block;
  color: var(--ink-soft);
  font-size: var(--fs-sm);
  font-weight: 500;
  margin-bottom: 7px;
}
.stats strong {
  font-size: var(--fs-xl);
  font-weight: 700;
  letter-spacing: -0.025em;
  color: var(--ink-strong);
  font-variant-numeric: tabular-nums;
}
.by-model {
  margin-top: var(--sp-5);
}
.runtime-panel {
  margin-top: var(--sp-5);
  padding-top: var(--sp-4);
  border-top: 1px solid var(--line);
}
.runtime-controls {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}
.runtime-controls .toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-sm);
  color: var(--ink-soft);
  cursor: pointer;
}
.runtime-controls .toggle input {
  accent-color: var(--brand);
}
.rt-hero {
  display: flex;
  gap: var(--sp-4);
  align-items: stretch;
  margin-bottom: var(--sp-5);
}
.rt-hero-main {
  flex: 1.6;
  position: relative;
  background: linear-gradient(135deg, #3370ff 0%, #5b8cff 55%, #7c5cd6 100%);
  color: #fff;
  border-radius: var(--radius);
  padding: var(--sp-5);
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
  overflow: hidden;
  box-shadow: 0 8px 24px -6px rgba(51, 112, 255, 0.4);
}
.rt-hero-main::after {
  content: '';
  position: absolute;
  right: -40px;
  top: -60px;
  width: 180px;
  height: 180px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.12);
}
.rt-hero-label {
  font-size: var(--fs-base);
  opacity: 0.88;
  position: relative;
}
.rt-hero-num {
  display: flex;
  align-items: baseline;
  gap: 8px;
  position: relative;
}
.rt-hero-num strong {
  font-size: 48px;
  line-height: 1;
  letter-spacing: -0.035em;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.rt-hero-max {
  font-size: var(--fs-lg);
  opacity: 0.82;
}
.rt-hero-tag {
  align-self: flex-start;
  margin-top: 6px;
  font-size: var(--fs-sm);
  font-weight: 600;
  padding: 3px 11px;
  border-radius: var(--radius-pill);
  background: rgba(255, 255, 255, 0.2);
  position: relative;
}
.rt-hero-tag.on {
  background: rgba(255, 255, 255, 0.32);
}
.rt-hero-side {
  flex: 1;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--sp-3);
}
.rt-hero-item {
  background: var(--n-25);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: var(--sp-4);
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 7px;
}
.rt-hero-item-label {
  font-size: var(--fs-sm);
  color: var(--ink-soft);
  font-weight: 500;
}
.rt-hero-item-num {
  font-size: var(--fs-2xl);
  font-weight: 700;
  letter-spacing: -0.03em;
  color: var(--brand-ink);
  font-variant-numeric: tabular-nums;
}
.rt-block {
  margin-bottom: var(--sp-5);
}
.rt-block-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: var(--sp-3);
}
.rt-block-title h5 {
  margin: 0;
  font-size: var(--fs-md);
  font-weight: 650;
}
.rt-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.rt-chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 8px 14px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--n-0);
  font-size: var(--fs-base);
  box-shadow: var(--shadow-xs);
}
.rt-chip.live {
  border-color: #bcd4ff;
  background: var(--brand-softer);
}
.rt-chip-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--brand);
  box-shadow: 0 0 0 4px rgba(51, 112, 255, 0.15);
  flex-shrink: 0;
  animation: pulse 1.8s ease-in-out infinite;
}
@keyframes pulse {
  0%,
  100% {
    box-shadow: 0 0 0 3px rgba(51, 112, 255, 0.16);
  }
  50% {
    box-shadow: 0 0 0 6px rgba(51, 112, 255, 0.06);
  }
}
.rt-chip-name {
  font-weight: 600;
}
.rt-chip-num {
  font-weight: 700;
  font-size: var(--fs-lg);
  color: var(--brand-ink);
  font-variant-numeric: tabular-nums;
}
.rt-chip-limit {
  color: var(--ink-faint);
  font-size: var(--fs-sm);
}
.rt-empty {
  color: var(--ink-soft);
  font-size: var(--fs-base);
  padding: 10px 0;
}
.rt-models {
  display: flex;
  flex-direction: column;
  gap: 11px;
}
.rt-model {
  display: grid;
  grid-template-columns: 1fr 3fr auto;
  align-items: center;
  gap: var(--sp-3);
}
.rt-model-name {
  font-size: var(--fs-base);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rt-model-track {
  height: 8px;
  border-radius: var(--radius-pill);
  background: var(--n-100);
  overflow: hidden;
}
.rt-model-bar {
  height: 100%;
  border-radius: var(--radius-pill);
  background: linear-gradient(90deg, #5b8cff, var(--brand));
  transition: width 0.35s var(--ease);
}
.rt-model-num {
  font-size: var(--fs-base);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.dot-ind {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--n-300);
  margin-right: 6px;
  vertical-align: middle;
}
.dot-ind.on {
  background: var(--ok);
  box-shadow: 0 0 0 3px rgba(18, 161, 80, 0.15);
}
.row-dim {
  opacity: 0.5;
}
.runtime-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-4);
  margin-bottom: var(--sp-4);
}
.runtime-col h5 {
  margin: 0 0 var(--sp-2);
  font-size: var(--fs-base);
  font-weight: 650;
}
.table.mini th,
.table.mini td {
  padding: 6px 8px;
  font-size: var(--fs-sm);
}
.table.mini thead th {
  position: sticky;
  top: 0;
}
.row-between {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--sp-3);
  margin-bottom: var(--sp-3);
}
h3,
h4 {
  margin: 0 0 var(--sp-3);
}
h3 {
  font-size: var(--fs-lg);
  font-weight: 650;
}
h4 {
  font-size: var(--fs-md);
  font-weight: 650;
}
.hint {
  color: var(--ink-soft);
  font-size: var(--fs-sm);
  margin: 0 0 var(--sp-3);
  line-height: 1.6;
}
.hint code,
.mono {
  font-family: var(--mono);
}
.hint code {
  font-size: 0.92em;
  background: var(--n-75);
  border: 1px solid var(--line);
  border-radius: 5px;
  padding: 1px 5px;
}
.inline-input {
  display: flex;
  gap: var(--sp-2);
  align-items: center;
}
.inline-input input {
  flex: 1;
}
.protocol-test-result {
  margin-top: var(--sp-2);
  padding: 9px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: var(--fs-sm);
}
.protocol-test-result.ok {
  background: var(--ok-soft);
  border-color: #b7e8c9;
}
.protocol-test-result.err {
  background: var(--danger-soft);
  border-color: #f8d4d5;
}
.protocol-test-result strong.ok {
  color: var(--ok-ink);
}
.protocol-test-result strong.warn {
  color: var(--warn-ink);
}
.protocol-test-result .mono.small {
  word-break: break-all;
}
.search {
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  padding: 9px 12px;
  min-width: 220px;
}
.actions {
  display: flex;
  gap: var(--sp-2);
  flex-wrap: wrap;
}
.actions-inline {
  flex-wrap: nowrap;
  justify-content: flex-end;
  gap: 6px;
}
.table-scroll {
  overflow-x: auto;
  margin: 0 -2px;
  padding: 0 2px;
}
.models-table {
  min-width: 880px;
}
.models-table th,
.models-table td {
  vertical-align: top;
  padding: 14px 13px;
}
.col-actions {
  width: 1%;
  white-space: nowrap;
  text-align: right;
}
/* —— 用户用量面板 —— */
.ru-controls {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}
.ru-control {
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  padding: 7px 11px;
  background: var(--n-0);
  font-size: var(--fs-base);
  flex-shrink: 0;
}
.ru-stats {
  margin-bottom: var(--sp-4);
}
.ru-user {
  font-weight: 600;
  font-size: var(--fs-base);
  color: var(--ink-strong);
}
.ru-prompt {
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-soft);
  font-size: var(--fs-sm);
}
.ru-detail {
  margin-top: var(--sp-5);
  padding-top: var(--sp-4);
  border-top: 1px solid var(--line);
}
.ru-detail .filters {
  margin: 10px 0 var(--sp-3);
}
.ru-detail .chip {
  display: inline-block;
  padding: 2px 9px;
  border-radius: var(--radius-pill);
  font-size: var(--fs-sm);
  font-weight: 600;
}
.ru-detail .chip-ok {
  background: var(--ok-soft);
  color: var(--ok-ink);
}
.ru-detail .chip-err {
  background: var(--danger-soft);
  color: var(--danger-ink);
}
.ru-detail .pager {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  justify-content: center;
  margin-top: var(--sp-3);
}
.ru-detail .muted {
  color: var(--ink-soft);
  font-size: var(--fs-sm);
}
.ru-detail .err {
  color: var(--danger-ink);
}
.ru-detail .empty-inline {
  color: var(--ink-soft);
  font-size: var(--fs-base);
  padding: var(--sp-2) 0;
}
/* 角色徽标 */
.role-chip {
  display: inline-block;
  padding: 3px 10px;
  border-radius: var(--radius-pill);
  font-size: var(--fs-sm);
  font-weight: 600;
  line-height: 1.4;
  white-space: nowrap;
}
.role-admin {
  background: var(--violet-soft);
  color: var(--violet-ink);
}
.role-dev {
  background: var(--info-soft);
  color: var(--info-ink);
}
.role-user {
  background: var(--n-100);
  color: var(--ink-soft);
}
/* 集市开发者 + 需求单 */
.ru-devbox {
  background: var(--n-25);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  padding: var(--sp-3) var(--sp-4);
  margin: 6px 0 var(--sp-4);
}
.ru-devhead {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.ru-dev-no {
  color: var(--ink-soft);
  font-size: var(--fs-sm);
  margin-top: var(--sp-2);
}
.ru-devreqs {
  margin-top: var(--sp-3);
}
.req-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.req-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 9px 11px;
  background: var(--n-0);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  transition: border-color var(--dur) var(--ease);
}
.req-item:hover {
  border-color: var(--line-strong);
}
.req-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--fs-base);
  font-weight: 550;
}
.req-stage {
  display: inline-block;
  padding: 2px 9px;
  border-radius: var(--radius-pill);
  font-size: var(--fs-xs);
  font-weight: 600;
  color: #fff;
  flex-shrink: 0;
}
.stage-review {
  background: var(--violet);
}
.stage-dev {
  background: var(--info);
}
.stage-deploy {
  background: var(--ok);
}
.stage-other {
  background: var(--n-400);
}
.req-meta {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-3);
}
.empty-inline {
  color: var(--ink-soft);
  font-size: var(--fs-base);
  padding: var(--sp-2) 0;
}
.model-cell {
  min-width: 160px;
}
.model-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.model-name {
  font-weight: 650;
  color: var(--ink-strong);
}
.model-slug {
  margin-top: 4px;
  font-size: var(--fs-sm);
  color: var(--ink-soft);
}
.upstream-cell {
  max-width: 240px;
}
.upstream-url {
  font-size: var(--fs-sm);
  color: var(--ink-soft);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 240px;
}
.tag-row {
  display: flex;
  gap: 6px;
  margin-top: 6px;
  flex-wrap: wrap;
}
.price-grid {
  display: grid;
  gap: 3px;
  font-size: var(--fs-sm);
  line-height: 1.35;
  min-width: 108px;
}
.price-grid span {
  display: inline-block;
  width: 28px;
  color: var(--ink-faint);
  font-family: inherit;
}
.price-img span {
  width: 28px;
}
.limit-cell {
  font-size: var(--fs-base);
  min-width: 120px;
}
.status-pill {
  display: inline-flex;
  align-items: center;
  padding: 3px 11px;
  border-radius: var(--radius-pill);
  font-size: var(--fs-sm);
  font-weight: 600;
}
.status-pill.on {
  background: var(--ok-soft);
  color: var(--ok-ink);
}
.status-pill.off {
  background: var(--n-100);
  color: var(--ink-soft);
}
.small {
  font-size: var(--fs-sm);
}
.pill {
  display: inline-flex;
  align-items: center;
  font-size: var(--fs-xs);
  font-weight: 600;
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  background: var(--ok-soft);
  color: var(--ok-ink);
  line-height: 1.4;
}
.pill-mm {
  background: var(--info-soft);
  color: var(--info-ink);
}
.pill-type {
  background: var(--ok-soft);
  color: var(--ok-ink);
}
.pill-think {
  background: var(--violet-soft);
  color: var(--violet-ink);
}
.pill-claude {
  background: var(--warn-soft);
  color: var(--warn-ink);
}
.pill-responses {
  background: #fdeef6;
  color: #b02a72;
}
.pill-ctx {
  background: var(--n-100);
  color: var(--ink-soft);
}
.pill-dev {
  background: #eef2ff;
  color: #4338ca;
}
.pill-muted {
  background: var(--n-100);
  color: var(--ink-soft);
  font-weight: 500;
}
.check {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-base);
}
.form {
  margin-top: var(--sp-5);
  padding-top: var(--sp-4);
  border-top: 1px solid var(--line);
}
.fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-3);
}
.field.full {
  grid-column: 1 / -1;
}
.test-panel {
  margin-top: var(--sp-4);
}
.test-inline {
  margin-top: var(--sp-5);
  padding-top: var(--sp-4);
  border-top: 1px dashed var(--line-strong);
}
.preview-card {
  margin: 0 0 var(--sp-4);
  padding: var(--sp-4);
  border: 1px solid var(--line);
  border-top: 3px solid var(--brand);
  border-radius: var(--radius);
  background: var(--n-0);
  max-width: 380px;
  box-shadow: var(--shadow-sm);
}
.preview-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.preview-desc {
  margin: 8px 0 0;
  color: var(--ink-soft);
  font-size: var(--fs-base);
  line-height: 1.55;
  min-height: 36px;
}
.preview-meta {
  display: grid;
  gap: 4px;
  font-size: var(--fs-sm);
  margin: 10px 0;
}
.preview-meta span {
  display: inline-block;
  width: 42px;
  color: var(--ink-faint);
}
.preview-foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.state {
  font-size: var(--fs-sm);
  color: var(--ink-soft);
}
.state.on {
  color: var(--ok-ink);
  font-weight: 600;
}
.test-result {
  margin-top: var(--sp-4);
  padding: var(--sp-3) var(--sp-4);
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--n-25);
}
.test-result.pass {
  border-color: #b7e8c9;
  background: var(--ok-soft);
}
.test-result.fail {
  border-color: #f8d4d5;
  background: var(--danger-soft);
  color: var(--danger-ink);
}
.test-content {
  margin: 8px 0 0;
  padding: 11px;
  max-height: 240px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--mono);
  font-size: var(--fs-sm);
  background: var(--n-0);
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  line-height: 1.6;
}
.test-content.reasoning {
  color: var(--violet-ink);
  background: var(--violet-soft);
}
.usage-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin: 8px 0;
  padding: 9px 11px;
  background: var(--brand-softer);
  border-radius: var(--radius-sm);
  border: 1px solid #dbe6ff;
}
.usage-cap {
  font-weight: 650;
  color: var(--brand-ink);
  margin-right: 4px;
}
.usage-line .warn {
  color: var(--warn-ink);
}
.raw-note {
  margin: 6px 0;
  font-size: var(--fs-sm);
  color: var(--ink-soft);
}
.raw-cap {
  margin: 8px 0 2px;
}
.muted {
  color: var(--ink-soft);
}
@media (max-width: 800px) {
  .stats,
  .fields {
    grid-template-columns: 1fr;
  }
  .rt-hero,
  .runtime-grid {
    flex-direction: column;
    grid-template-columns: 1fr;
  }
  .tabs {
    width: 100%;
  }
}
</style>
