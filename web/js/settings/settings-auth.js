/**
 * 设置页 · 登录与异地访问（1.25）
 *
 * 面板内容：
 *   · 当前状态（是否启用登录 / 监听范围 / 实际绑定地址 / 最近登录 IP 与时间 / 锁定剩余）
 *   · 登录开关、登录用户名、设置 / 修改密码（改密后所有旧会话失效）
 *   · 监听范围三档（local / lan / all，切换后必须重启服务）
 *   · IP / CIDR 白名单（空 = 不限制）
 *   · 三套免费异地访问方案的操作指引（Tailscale / Cloudflare Tunnel / 公网 IPv6）
 */
'use strict';

window.CRM = window.CRM || {};

(function (CRM) {

  const AuthPanel = {
    name: 'AuthPanel',
    data() {
      return {
        loading: true,
        saving: false,
        status: null,
        form: {
          auth_user: 'admin',
          listen_mode: 'local',
          auth_ip_allow: ''
        },
        pwd: {
          old_password: '',
          new_password: '',
          confirm: ''
        },
        pwdSaving: false,
        plan: 'tailscale',
        plans: [
          {
            key: 'tailscale',
            name: 'A · Tailscale（推荐）',
            cost: '0 元 · 免费版最多 6 个用户、设备数量不限',
            when: '不想买域名，想最安全（不对公网开放任何端口）',
            steps: [
              '本机安装 Tailscale 并登录（tailscale.com 免费下载；免费版 6 个用户、设备不限）。',
              '手机装 Tailscale App，登录同一个账号，两台设备自动进入同一虚拟内网。',
              '回到本软件「登录与异地访问」：先设置密码，再开启登录，监听范围选「局域网」或「全部网卡」。',
              '把 IP 白名单填成 100.64.0.0/10（Tailscale 专用网段），只允许虚拟内网的设备访问。',
              '保存后关闭服务窗口、双击 启动.bat 重启；手机浏览器打开 100.x.x.x:8899（地址在 Tailscale 面板查看）。'
            ],
            note: '数据始终保存在本机，Tailscale 只负责设备组网，不经过任何云端数据库。'
          },
          {
            key: 'cloudflare',
            name: 'B · Cloudflare Tunnel',
            cost: '0 元 + 域名约 10~30 元/年',
            when: '想发个链接就能在微信里打开',
            steps: [
              '准备一个域名并托管到 Cloudflare（免费套餐即可）。',
              '本机安装 cloudflared，执行 cloudflared tunnel login 登录 Cloudflare 账号。',
              '执行 cloudflared tunnel create crm 创建隧道，再 cloudflared tunnel route dns crm crm.你的域名。',
              '在 config.yml 里把服务指向 http://127.0.0.1:8899，执行 cloudflared tunnel run crm 启动隧道。',
              '手机浏览器打开 crm.你的域名（Cloudflare 会自动启用 HTTPS）；访问前务必先在本软件里设好登录密码并开启登录。'
            ],
            note: '数据仍在本机，Cloudflare 只做加密转发；因为出口 IP 不固定，这个方案不建议填 IP 白名单。'
          },
          {
            key: 'ipv6',
            name: 'C · 公网 IPv6 + DDNS',
            cost: '0 元（需要宽带提供公网 IPv6）',
            when: '宽带有公网 IPv6、不想装任何客户端',
            steps: [
              '确认宽带分到了公网 IPv6（路由器 WAN 口能看到 240e / 2408 等开头的地址）。',
              '路由器里放行本机 IPv6 的 8899 端口（建议换成高位端口），并给本机固定 IPv6 后缀。',
              '在 DDNS 服务（如 DuckDNS、阿里云 DNS）把域名解析到本机的 IPv6 地址。',
              '软件里设置登录密码 → 开启登录 → 监听范围选「全部网卡」，保存后重启服务。',
              '手机（需支持 IPv6）浏览器打开 你的域名:8899。'
            ],
            note: '公网裸奔风险最高：务必设强密码，最好在路由器防火墙里只放行自己常用的来源地址。'
          }
        ]
      };
    },
    computed: {
      listenLabel() {
        return { local: '仅本机', lan: '局域网', all: '全部网卡' }[this.form.listen_mode] || '仅本机';
      },
      bindLabel() {
        const s = this.status;
        if (!s) return '—';
        return `${s.bind_address}:${s.port || ''}`.replace(/:$/, '');
      },
      canRemote() {
        return !!(this.status && this.status.can_remote);
      },
      remoteNeedsRestart() {
        return !!(this.status && this.status.restart_required);
      },
      lockMinutes() {
        const sec = (this.status && this.status.lock && this.status.lock.remaining_sec) || 0;
        return sec > 0 ? Math.ceil(sec / 60) : 0;
      },
      currentPlan() {
        return this.plans.find((p) => p.key === this.plan) || this.plans[0];
      }
    },
    setup() {
      return { fmtDate: CRM.util.fmtDate };
    },
    methods: {
      async load() {
        this.loading = true;
        try {
          const [st, s] = await Promise.all([CRM.auth.status(), CRM.api.getSettings()]);
          this.status = st;
          this.form.auth_user = (s.settings && s.settings.auth_user) || 'admin';
          this.form.listen_mode = (s.settings && s.settings.listen_mode) || 'local';
          this.form.auth_ip_allow = (s.settings && s.settings.auth_ip_allow) || '';
        } catch (e) {
          CRM.toast(e.message || '加载登录设置失败', 'error');
        } finally {
          this.loading = false;
        }
      },

      async refreshStatus() {
        try {
          this.status = await CRM.auth.status();
          CRM.auth.applyStatus(this.status);
        } catch (e) {
          CRM.toast(e.message || '获取状态失败', 'error');
        }
      },

      /** 启用 / 关闭登录（启用前必须先有密码） */
      async toggleAuth() {
        if (!this.status) return;
        const next = this.status.auth_enabled ? '0' : '1';
        if (next === '1' && !this.status.has_password) {
          CRM.toast('请先在下面设置登录密码，再启用登录', 'error', 6000);
          return;
        }
        this.saving = true;
        try {
          await CRM.api.saveSettings({ auth_enabled: next });
          await this.refreshStatus();
          if (next === '1') {
            if (this.status.logged_in) {
              CRM.toast('登录已启用，当前会话仍然有效', 'success');
            } else {
              CRM.toast('登录已启用，请用刚设置的密码登录', 'success', 5000);
              setTimeout(() => window.location.replace('/login.html'), 900);
            }
          } else {
            CRM.toast('登录已关闭：现在访问无需登录（仍只监听本机时最安全）', 'success', 6000);
          }
        } catch (e) {
          CRM.toast(e.message || '保存失败', 'error', 8000);
        } finally {
          this.saving = false;
        }
      },

      async saveUser() {
        const name = String(this.form.auth_user || '').trim();
        if (!name) { CRM.toast('登录用户名不能为空', 'error'); return; }
        this.saving = true;
        try {
          await CRM.api.saveSettings({ auth_user: name });
          await this.refreshStatus();
          if (this.status.auth_enabled) {
            /* 用户名变了，旧会话里的 u 不再匹配，需要重新登录 */
            CRM.toast('用户名已更新，请重新登录', 'success', 5000);
            setTimeout(() => window.location.replace('/login.html'), 900);
          } else {
            CRM.toast('登录用户名已保存', 'success');
          }
        } catch (e) {
          CRM.toast(e.message || '保存失败', 'error', 8000);
        } finally {
          this.saving = false;
        }
      },

      async saveListen(mode, ev) {
        if (!this.status || mode === this.form.listen_mode) return;
        /* 切到非本机前必须先有密码，前端先给一次明确提示（后端还会再校验） */
        if (mode !== 'local' && !this.status.has_password) {
          CRM.toast('开启局域网 / 异地访问前，请先设置登录密码', 'error', 7000);
          if (ev && ev.target) ev.target.value = this.form.listen_mode;
          return;
        }
        const ok = await CRM.confirm({
          title: '修改监听范围',
          message: mode === 'local'
            ? '改回「仅本机」后，其他设备将无法访问。修改需重启服务才生效。'
            : '即将允许其他设备访问本软件。<br>请确认：<strong>已设置登录密码</strong>，'
              + '并且只在自己信任的网络里使用（推荐配合 Tailscale）。<br>修改需重启服务才生效。',
          danger: mode !== 'local'
        });
        if (!ok) {
          /* 取消时把下拉框恢复成已保存的值 */
          if (ev && ev.target) ev.target.value = this.form.listen_mode;
          return;
        }
        this.saving = true;
        try {
          const r = await CRM.api.saveSettings({ listen_mode: mode });
          this.form.listen_mode = mode;
          await this.refreshStatus();
          const msg = r.restart_required
            ? '已保存。请关闭服务窗口后重新双击 启动.bat，新的监听范围才会生效。'
            : '监听范围已保存';
          CRM.toast(msg, 'warn', 10000);
          if (r.warning) CRM.toast(r.warning, 'warn', 10000);
        } catch (e) {
          this.form.listen_mode = (this.status && this.status.listen_mode) || 'local';
          if (ev && ev.target) ev.target.value = this.form.listen_mode;
          CRM.toast(e.message || '保存失败', 'error', 9000);
        } finally {
          this.saving = false;
        }
      },

      async saveAllow() {
        const value = String(this.form.auth_ip_allow || '').trim();
        if (value) {
          const ok = await CRM.confirm({
            title: '保存 IP 白名单',
            message: `只有下列地址能访问本软件：<br><strong>${value}</strong><br>`
              + '如果连自己当前的 IP 都不在名单里，保存后会立刻无法访问。确定保存吗？',
            danger: true
          });
          if (!ok) return;
        }
        this.saving = true;
        try {
          await CRM.api.saveSettings({ auth_ip_allow: value });
          this.form.auth_ip_allow = value;
          await this.refreshStatus();
          CRM.toast(value ? 'IP 白名单已保存（立即生效）' : '已清空白名单：不限制来源 IP', 'success', 6000);
        } catch (e) {
          CRM.toast(e.message || '保存失败', 'error', 9000);
        } finally {
          this.saving = false;
        }
      },

      async savePassword() {
        const cur = this.pwd;
        if (!cur.new_password || cur.new_password.length < 6) {
          CRM.toast('新密码至少 6 位', 'error');
          return;
        }
        if (cur.new_password !== cur.confirm) {
          CRM.toast('两次输入的新密码不一致', 'error');
          return;
        }
        if (this.status && this.status.has_password && !cur.old_password) {
          CRM.toast('请输入当前密码', 'error');
          return;
        }
        this.pwdSaving = true;
        try {
          const payload = { new_password: cur.new_password };
          if (this.status && this.status.has_password) payload.old_password = cur.old_password;
          const r = await CRM.api.authChangePassword(payload);
          this.pwd = { old_password: '', new_password: '', confirm: '' };
          await this.refreshStatus();
          if (r && r.relogin) {
            CRM.toast('密码已修改，所有旧登录已失效，请用新密码重新登录', 'success', 8000);
            setTimeout(() => window.location.replace('/login.html'), 1200);
          } else {
            CRM.toast('登录密码已设置。现在可以开启登录了', 'success', 7000);
          }
        } catch (e) {
          CRM.toast(e.message || '设置密码失败', 'error', 9000);
        } finally {
          this.pwdSaving = false;
        }
      }
    },
    async created() { this.load(); },
    template: `
      <div>
        <div v-if="loading" class="card"><div class="card-body muted">加载中…</div></div>
        <template v-else>
          <!-- ============ 当前状态 ============ -->
          <c-card title="登录与异地访问 · 当前状态"
                  sub="默认不启用登录、只监听本机；异地访问是显式开启的能力，数据始终保存在本机"
                  icon="lock">
            <div class="kv">
              <div class="k">登录</div>
              <div class="v">
                <span class="tag" :class="status && status.auth_enabled ? 'success' : 'muted'">
                  {{ status && status.auth_enabled ? '已启用（' + (status.username || 'admin') + ' 已登录）' : '未启用（默认，打开即用）' }}
                </span>
              </div>
              <div class="k">监听范围</div>
              <div class="v">
                {{ listenLabel }}
                <span class="muted">（实际绑定 {{ status ? status.bind_address : '—' }}）</span>
                <span v-if="remoteNeedsRestart" class="tag warning" style="margin-left:6px">重启后生效</span>
              </div>
              <div class="k">异地可访问</div>
              <div class="v">{{ canRemote ? '是（其他设备可连）' : '否（只有本机能访问）' }}</div>
              <div class="k">最近登录</div>
              <div class="v">
                <template v-if="status && status.last_login">
                  {{ status.last_login.ip || '—' }} · {{ fmtDate(status.last_login.at, true) }}
                </template>
                <span v-else class="muted">还没有登录记录</span>
              </div>
              <div class="k">失败锁定</div>
              <div class="v">
                <span v-if="lockMinutes" style="color:var(--c-warning)">已锁定，剩余约 {{ lockMinutes }} 分钟</span>
                <span v-else class="muted">未锁定（同一 IP 连错 5 次锁 15 分钟）</span>
              </div>
            </div>

            <div class="note mt-4">
              <c-icon name="alert" :size="16" />
              <div style="font-size:var(--fs-sm)">
                <strong>安全提示：</strong>开启异地访问前必须先设置登录密码；建议只通过
                Tailscale 等虚拟内网访问，并把 IP 白名单限制为可信网段，不要把端口直接暴露到公网。
              </div>
            </div>

            <div class="mt-4" style="display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn btn-sm" @click="refreshStatus">
                <c-icon name="refresh" :size="13" /> 刷新状态
              </button>
            </div>
          </c-card>

          <!-- ============ 登录密码 ============ -->
          <c-card class="mt-4" title="登录密码" sub="密码只保存 scrypt 加盐哈希，界面与日志永远不会出现明文" icon="lock">
            <div class="form-grid">
              <div class="field">
                <label class="field-label">启用登录</label>
                <div class="switch" @click="toggleAuth">
                  <input type="checkbox" :checked="status && status.auth_enabled" readonly />
                  <span class="switch-track"><span class="switch-thumb"></span></span>
                  <span class="switch-text">{{ status && status.auth_enabled ? '已开启' : '已关闭' }}</span>
                </div>
                <div class="field-hint">开启后，所有接口都需要先登录；关闭后恢复「打开即用」</div>
              </div>

              <div class="field">
                <label class="field-label">登录用户名</label>
                <input class="input" v-model="form.auth_user" maxlength="64" placeholder="admin" />
                <div class="field-hint">
                  改用户名后需要重新登录
                  <button class="link-btn" style="margin-left:6px" :disabled="saving" @click="saveUser">保存用户名</button>
                </div>
              </div>
            </div>

            <div class="note mt-4" v-if="status && status.has_password">
              <c-icon name="check" :size="16" />
              <div style="font-size:var(--fs-sm)">已设置登录密码。修改密码后，<strong>所有已登录的设备都会立刻退出</strong>，需要重新登录。</div>
            </div>
            <div class="note warn mt-4" v-else>
              <c-icon name="alert" :size="16" />
              <div style="font-size:var(--fs-sm)">
                还没有设置登录密码。请先在下面设置（至少 6 位），然后才能启用登录或开启局域网 / 异地访问。
              </div>
            </div>

            <div class="form-grid mt-4">
              <div v-if="status && status.has_password" class="field">
                <label class="field-label">当前密码</label>
                <input class="input" type="password" v-model="pwd.old_password" autocomplete="current-password"
                       placeholder="修改密码需要验证当前密码" />
              </div>
              <div class="field">
                <label class="field-label">{{ status && status.has_password ? '新密码' : '设置密码' }}</label>
                <input class="input" type="password" v-model="pwd.new_password" autocomplete="new-password"
                       placeholder="至少 6 位" />
              </div>
              <div class="field">
                <label class="field-label">确认新密码</label>
                <input class="input" type="password" v-model="pwd.confirm" autocomplete="new-password"
                       placeholder="再输入一次" @keydown.enter="savePassword" />
              </div>
            </div>

            <div class="mt-4" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <button class="btn btn-primary" :disabled="pwdSaving" @click="savePassword">
                {{ pwdSaving ? '保存中…' : (status && status.has_password ? '修改密码' : '设置登录密码') }}
              </button>
              <span class="muted" style="font-size:var(--fs-xs)">
                忘记密码：停止服务后在本机执行 <span class="mono-text">node tools/reset-password.js</span>（会清空密码并关闭登录）
              </span>
            </div>
          </c-card>

          <!-- ============ 监听范围 ============ -->
          <c-card class="mt-4" title="监听范围" sub="决定哪些设备能连上本软件；切换后必须重启服务才生效" icon="globe">
            <div class="form-grid">
              <div class="field">
                <label class="field-label">允许访问的来源</label>
                <select class="input" :value="form.listen_mode" :disabled="saving"
                        @change="saveListen($event.target.value, $event)">
                  <option value="local">仅本机（127.0.0.1，默认最安全）</option>
                  <option value="lan">局域网（0.0.0.0，家里 / 办公室其他设备可访问）</option>
                  <option value="all">全部网卡（0.0.0.0，配合 Tailscale / 隧道做异地访问）</option>
                </select>
                <div class="field-hint">
                  当前保存值：{{ listenLabel }}；改动后请关闭服务窗口并重新双击 启动.bat
                </div>
              </div>
            </div>

            <div class="note warn mt-4" v-if="form.listen_mode !== 'local' && !(status && status.auth_enabled)">
              <c-icon name="alert" :size="16" />
              <div style="font-size:var(--fs-sm)">
                已选择对外开放，但登录还没启用：<strong>任何能连上本机的人都能读写客户资料</strong>。请立刻开启登录。
              </div>
            </div>

            <div class="note mt-4" v-if="remoteNeedsRestart">
              <c-icon name="refresh" :size="16" />
              <div style="font-size:var(--fs-sm)">
                监听范围已保存，但当前进程仍绑定 <span class="mono-text">{{ status.bind_address }}</span>；
                <strong>请关闭服务窗口后重新双击 启动.bat</strong>，新范围才会生效。
              </div>
            </div>
          </c-card>

          <!-- ============ IP 白名单 ============ -->
          <c-card class="mt-4" title="IP 白名单（可选）" sub="留空 = 不限制来源；填了以后不在名单内的请求一律 403" icon="shield">
            <div class="field">
              <label class="field-label">允许访问的 IP / 网段</label>
              <input class="input" v-model="form.auth_ip_allow"
                     placeholder="例如：100.64.0.0/10,192.168.1.0/24,127.0.0.1" />
              <div class="field-hint">
                逗号分隔，支持单个 IP 或 CIDR。Tailscale 用户填 <span class="mono-text">100.64.0.0/10</span> 即可只允许虚拟内网访问。
              </div>
            </div>
            <div class="mt-4">
              <button class="btn btn-primary" :disabled="saving" @click="saveAllow">保存白名单</button>
            </div>
          </c-card>

          <!-- ============ 免费方案 ============ -->
          <c-card class="mt-4" title="异地访问 · 三套免费方案"
                  sub="共同前提：先设置登录密码并开启登录；数据始终保存在本机，不经过云端数据库" icon="globe">
            <div class="tabs" style="margin-bottom:12px">
              <button v-for="p in plans" :key="p.key" class="tab" :class="{ active: plan === p.key }"
                      @click="plan = p.key">{{ p.name }}</button>
            </div>

            <div class="note">
              <c-icon name="alert" :size="16" />
              <div style="font-size:var(--fs-sm)">
                <strong>{{ currentPlan.name }}</strong><br>
                费用：{{ currentPlan.cost }}<br>
                适合：{{ currentPlan.when }}
              </div>
            </div>

            <ol style="margin:14px 0 0;padding-left:20px;font-size:var(--fs-sm);line-height:2">
              <li v-for="(s, i) in currentPlan.steps" :key="i">{{ s }}</li>
            </ol>

            <div class="note mt-4">
              <c-icon name="database" :size="16" />
              <div style="font-size:var(--fs-sm)">{{ currentPlan.note }}</div>
            </div>

            <div class="note mt-4">
              <c-icon name="lock" :size="16" />
              <div style="font-size:var(--fs-sm)">
                <strong>安全底线：</strong>登录密码 + 5 次失败锁定 15 分钟 + 可选 IP 白名单；
                不要在没有密码的情况下把监听范围改成局域网 / 全部网卡。
              </div>
            </div>
          </c-card>
        </template>
      </div>`
  };

  CRM.settings = CRM.settings || {};
  CRM.settings.AuthPanel = AuthPanel;

})(window.CRM);
