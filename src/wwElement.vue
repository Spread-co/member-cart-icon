<template>
  <div class="mci" :class="{ 'mci--guest': !content.isMember }">
    <button
      class="mci__btn"
      :class="{ 'mci__btn--active': cartCount > 0 }"
      :title="content.isMember ? 'View cart' : 'Membership required to shop'"
      :aria-label="content.isMember ? `Cart, ${cartCount} item${cartCount !== 1 ? 's' : ''}` : 'Cart — members only'"
      @click="handleClick"
    >
      <!-- Cart SVG icon -->
      <svg class="mci__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/>
        <line x1="3" y1="6" x2="21" y2="6"/>
        <path d="M16 10a4 4 0 0 1-8 0"/>
      </svg>

      <!-- Live count badge -->
      <span v-if="content.isMember && cartCount > 0" class="mci__badge" aria-hidden="true">
        {{ cartCount > 99 ? '99+' : cartCount }}
      </span>

      <!-- Loading pulse overlay (initial fetch) -->
      <span v-if="loading" class="mci__loading" aria-hidden="true"></span>

      <!-- Lock icon for non-members -->
      <span v-if="!content.isMember" class="mci__lock" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor" aria-hidden="true">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
      </span>
    </button>

    <!-- Non-member tooltip -->
    <div class="mci__tooltip" v-if="!content.isMember && showTooltip" role="tooltip">
      Members only — subscribe to shop
    </div>

    <!-- Error indicator -->
    <span v-if="loadError" class="mci__error-dot" title="Cart unavailable" aria-label="Cart error"></span>
  </div>
</template>

<script>
// ── Inline Supabase client (no shared imports — standalone component repo) ──
function createSpreadClient({ supabaseUrl, supabaseAnonKey, accessToken }) {
  const headers = { 'Content-Type': 'application/json', 'apikey': supabaseAnonKey };
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
  return {
    async rpc(fn, params = {}) {
      const res = await fetch(`${supabaseUrl}/rest/v1/rpc/${fn}`, {
        method: 'POST', headers, body: JSON.stringify(params),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: res.statusText }));
        throw new Error(`RPC ${fn}: ${err.message || res.status}`);
      }
      return res.json();
    },
  };
}

// ── Inline Realtime subscription (Phoenix Protocol WebSocket) ──
function createRealtimeSubscription({ supabaseUrl, supabaseAnonKey, accessToken, channelName, table, filter, onchange }) {
  const wsUrl = supabaseUrl
    .replace(/^https?:\/\//, match => match === 'https://' ? 'wss://' : 'ws://')
    + `/realtime/v1/websocket?vsn=1.0.0&apikey=${encodeURIComponent(supabaseAnonKey)}`;

  let ws = null;
  let heartbeatTimer = null;
  let ref = 0;
  let closed = false;

  function nextRef() { return ++ref; }
  function send(msg) {
    try {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    } catch (_) {}
  }

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    if (closed) { ws.close(); return; }
    send({
      topic: `realtime:${channelName}`,
      event: 'phx_join',
      payload: {
        config: {
          postgres_changes: [{ event: '*', schema: 'public', table, filter: filter || undefined }],
        },
        access_token: accessToken,
      },
      ref: String(nextRef()),
    });
    heartbeatTimer = setInterval(() => {
      send({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(nextRef()) });
    }, 25000);
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      // Postgres CDC events come as event='postgres_changes'
      if (msg.event === 'postgres_changes' && msg.payload) {
        onchange(msg.payload.data || msg.payload);
      }
    } catch (_) {}
  };

  ws.onerror = () => {};
  ws.onclose = () => { if (heartbeatTimer) clearInterval(heartbeatTimer); };

  return {
    close() {
      closed = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      try { if (ws) ws.close(); } catch (_) {}
    },
  };
}

export default {
  props: {
    /* wwEditor:start */
    wwEditorState: { type: Object, required: true },
    /* wwEditor:end */
    content: { type: Object, required: true },
    wwFrontState: { type: Object, required: true },
    wwElementState: { type: Object, required: true },
  },

  emits: ['trigger-event', 'update:content'],

  data() {
    return {
      cartCount: 0,
      cartId: null,
      loading: false,
      loadError: false,
      showTooltip: false,
      _realtimeSub: null,
    };
  },

  watch: {
    // Re-fetch when access token changes (login/logout)
    'content.accessToken'(newToken, oldToken) {
      if (newToken !== oldToken) {
        this.teardownRealtime();
        if (newToken && this.content.isMember) {
          this.fetchCart();
        } else {
          this.cartCount = 0;
          this.cartId = null;
        }
      }
    },
    // Set up realtime when cartId is resolved
    cartId(newId, oldId) {
      if (newId && newId !== oldId) {
        this.setupRealtime();
      }
    },
    // Reset when membership state changes
    'content.isMember'(isMember) {
      if (isMember && this.content.accessToken) {
        this.fetchCart();
      } else {
        this.teardownRealtime();
        this.cartCount = 0;
        this.cartId = null;
      }
    },
  },

  async mounted() {
    if (this.content.accessToken && this.content.isMember) {
      await this.fetchCart();
    }
  },

  beforeUnmount() {
    this.teardownRealtime();
  },

  methods: {
    async fetchCart() {
      const { supabaseUrl, supabaseAnonKey, accessToken } = this.content;
      if (!supabaseUrl || !supabaseAnonKey || !accessToken) return;

      this.loading = true;
      this.loadError = false;

      try {
        const client = createSpreadClient({ supabaseUrl, supabaseAnonKey, accessToken });
        const summary = await client.rpc('get_cart_summary');
        this.cartCount = Number(summary?.item_count) || 0;
        this.cartId = summary?.cart_id || null;
        this.loadError = false;
      } catch (err) {
        console.warn('[member-cart-icon] fetchCart failed:', err.message);
        this.loadError = true;
      } finally {
        this.loading = false;
      }
    },

    setupRealtime() {
      this.teardownRealtime();
      const { supabaseUrl, supabaseAnonKey, accessToken } = this.content;
      if (!supabaseUrl || !supabaseAnonKey || !accessToken || !this.cartId) return;

      this._realtimeSub = createRealtimeSubscription({
        supabaseUrl,
        supabaseAnonKey,
        accessToken,
        channelName: `cart-items-${this.cartId}`,
        table: 'cart_items',
        filter: `cart_id=eq.${this.cartId}`,
        onchange: () => {
          // Re-fetch on any cart_items change — simple, reliable, no delta tracking
          this.fetchCart();
        },
      });
    },

    teardownRealtime() {
      if (this._realtimeSub) {
        this._realtimeSub.close();
        this._realtimeSub = null;
      }
    },

    handleClick() {
      if (!this.content.isMember) {
        // Toggle tooltip for non-members
        this.showTooltip = !this.showTooltip;
        if (this.showTooltip) {
          setTimeout(() => { this.showTooltip = false; }, 2800);
        }
        this.$emit('trigger-event', { name: 'cart:locked', event: {} });
        return;
      }
      this.$emit('trigger-event', {
        name: 'cart:open',
        event: { cartId: this.cartId, itemCount: this.cartCount },
      });
    },
  },
};
</script>

<style scoped>
/* ── Design tokens ── */
.mci {
  --spread-primary: #4b162d;
  --spread-accent: #ce6632;
  --spread-gold: #bead38;
  --spread-beige: #e6d8ca;
  --spread-surface: #ffffff;
  --spread-border: #f3eadf;
  --spread-text-secondary: #2b2b2b;
  --spread-text-muted: #6b7280;
  --spread-radius-sm: 8px;
  --spread-radius-md: 12px;
  --spread-font: 'Work Sans', ui-sans-serif, system-ui, -apple-system, sans-serif;

  /* Component sizing */
  --mci-btn-size: 44px;
  --mci-icon-size: 22px;
  --mci-badge-size: 18px;

  position: relative;
  display: inline-flex;
  align-items: center;
  font-family: var(--spread-font);
}

/* ── Button ── */
.mci__btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--mci-btn-size);
  height: var(--mci-btn-size);
  border: none;
  border-radius: var(--spread-radius-sm);
  background: transparent;
  color: var(--spread-text-secondary);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease, transform 0.1s ease;
  -webkit-tap-highlight-color: transparent;
  padding: 0;
}

.mci__btn:hover {
  background: rgba(75, 22, 45, 0.06);
  color: var(--spread-primary);
}

.mci__btn:active {
  transform: scale(0.93);
}

.mci__btn:focus-visible {
  outline: 2px solid var(--spread-accent);
  outline-offset: 2px;
}

.mci__btn--active {
  color: var(--spread-primary);
}

/* Non-member dimmed state */
.mci--guest .mci__btn {
  color: var(--spread-text-muted);
  cursor: not-allowed;
}
.mci--guest .mci__btn:hover {
  background: rgba(107, 114, 128, 0.06);
  color: var(--spread-text-muted);
}

/* ── Icon ── */
.mci__icon {
  width: var(--mci-icon-size);
  height: var(--mci-icon-size);
  flex-shrink: 0;
}

/* ── Badge ── */
.mci__badge {
  position: absolute;
  top: 4px;
  right: 4px;
  min-width: var(--mci-badge-size);
  height: var(--mci-badge-size);
  padding: 0 4px;
  border-radius: 999px;
  background: var(--spread-accent);
  color: #ffffff;
  font-size: 10px;
  font-weight: 700;
  font-family: var(--spread-font);
  line-height: var(--mci-badge-size);
  text-align: center;
  pointer-events: none;
  box-sizing: border-box;
  animation: mci-badge-pop 0.2s ease;
}

@keyframes mci-badge-pop {
  0%   { transform: scale(0.6); opacity: 0; }
  70%  { transform: scale(1.15); }
  100% { transform: scale(1); opacity: 1; }
}

/* ── Lock icon (non-member) ── */
.mci__lock {
  position: absolute;
  bottom: 5px;
  right: 5px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--spread-text-muted);
  color: #fff;
  pointer-events: none;
}

/* ── Loading pulse ── */
.mci__loading {
  position: absolute;
  inset: 0;
  border-radius: var(--spread-radius-sm);
  background: rgba(75, 22, 45, 0.05);
  animation: mci-pulse 1.2s ease-in-out infinite;
  pointer-events: none;
}

@keyframes mci-pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}

/* ── Error dot ── */
.mci__error-dot {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #d14343;
  pointer-events: none;
}

/* ── Non-member tooltip ── */
.mci__tooltip {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  white-space: nowrap;
  background: var(--spread-primary);
  color: var(--spread-beige);
  font-size: 12px;
  font-weight: 500;
  padding: 6px 10px;
  border-radius: var(--spread-radius-sm);
  pointer-events: none;
  z-index: 1000;
  animation: mci-fade-in 0.15s ease;
}

.mci__tooltip::before {
  content: '';
  position: absolute;
  top: -5px;
  right: 10px;
  border-left: 5px solid transparent;
  border-right: 5px solid transparent;
  border-bottom: 5px solid var(--spread-primary);
}

@keyframes mci-fade-in {
  from { opacity: 0; transform: translateY(-4px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* ── Dark mode ── */
:global(html.dark) .mci__btn {
  color: var(--spread-beige);
}

:global(html.dark) .mci__btn:hover {
  background: rgba(230, 216, 202, 0.08);
  color: #ffffff;
}

:global(html.dark) .mci__btn--active {
  color: var(--spread-gold);
}

:global(html.dark) .mci--guest .mci__btn {
  color: rgba(230, 216, 202, 0.35);
}

/* ── Responsive ── */
@media (max-width: 768px) {
  .mci {
    --mci-btn-size: 40px;
    --mci-icon-size: 20px;
  }

  .mci__tooltip {
    right: auto;
    left: 50%;
    transform: translateX(-50%);
  }

  .mci__tooltip::before {
    right: auto;
    left: 50%;
    transform: translateX(-50%);
  }
}
</style>
