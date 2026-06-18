/**
 * ECOVITA — app.js v2.0
 * Meta Marketing API Integration + Claude AI Analysis Module
 * Suporte a múltiplas contas Meta Ads (até 15)
 *
 * Expõe globalmente:
 *   window.MetaAPI  — MetaAPIClient (multi-conta)
 *   window.AIModule — ClaudeAIModule
 *   window.metaFmt  — helpers de formatação
 *
 * localStorage:
 *   eco_meta_accounts      — JSON array de { id, name, token, accountId }
 *   eco_meta_active        — índice (number) da conta ativa
 *   eco_claude_key         — API Key do Claude
 */

'use strict';

// ═══════════════════════════════════════════════════════
// META MARKETING API CLIENT — MULTI-CONTA
// ═══════════════════════════════════════════════════════
class MetaAPIClient {
  constructor () {
    this.version = 'v20.0';
    this.base    = `https://graph.facebook.com/${this.version}`;

    // Carrega lista de contas
    this._accounts = this._loadAccounts();
    this._activeIdx = parseInt(localStorage.getItem('eco_meta_active') || '0', 10);
    if (this._activeIdx >= this._accounts.length) this._activeIdx = 0;

    // Reconstrói token/_accountId da conta ativa
    this._syncActive();
  }

  // ── Persistência de contas ────────────────────────────
  _loadAccounts () {
    try {
      const raw = localStorage.getItem('eco_meta_accounts');
      if (raw) return JSON.parse(raw);
    } catch {}
    // Migração de conta única legada
    const t = localStorage.getItem('eco_meta_token');
    const a = localStorage.getItem('eco_meta_account');
    if (t && a) {
      const legacy = [{ id: this._uid(), name: 'Conta Principal', token: t, accountId: a }];
      localStorage.setItem('eco_meta_accounts', JSON.stringify(legacy));
      localStorage.removeItem('eco_meta_token');
      localStorage.removeItem('eco_meta_account');
      return legacy;
    }
    return [];
  }

  _saveAccounts () {
    localStorage.setItem('eco_meta_accounts', JSON.stringify(this._accounts));
  }

  _syncActive () {
    const acc       = this._accounts[this._activeIdx] || null;
    this._token     = acc?.token     || '';
    this._accountId = acc?.accountId || '';
  }

  _uid () {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  // ── API pública de contas ─────────────────────────────
  get accounts ()   { return [...this._accounts]; }
  get activeIdx ()  { return this._activeIdx; }
  get activeAccount () { return this._accounts[this._activeIdx] || null; }
  get token ()      { return this._token; }
  get accountId ()  { return this._accountId; }

  /** Adiciona uma nova conta. Retorna false se já existir o mesmo accountId. */
  addAccount (name, token, accountId) {
    const acc = accountId.trim().startsWith('act_')
      ? accountId.trim()
      : `act_${accountId.trim()}`;
    if (this._accounts.some(a => a.accountId === acc)) return false;
    this._accounts.push({ id: this._uid(), name: name.trim(), token: token.trim(), accountId: acc });
    this._saveAccounts();
    return true;
  }

  /** Atualiza uma conta existente pelo index. */
  updateAccount (idx, name, token, accountId) {
    if (!this._accounts[idx]) return;
    const acc = accountId.trim().startsWith('act_') ? accountId.trim() : `act_${accountId.trim()}`;
    this._accounts[idx] = { ...this._accounts[idx], name: name.trim(), token: token.trim(), accountId: acc };
    this._saveAccounts();
    if (idx === this._activeIdx) this._syncActive();
  }

  /** Remove conta pelo index. Ajusta índice ativo se necessário. */
  removeAccount (idx) {
    if (idx < 0 || idx >= this._accounts.length) return;
    this._accounts.splice(idx, 1);
    if (this._activeIdx >= this._accounts.length) this._activeIdx = Math.max(0, this._accounts.length - 1);
    this._saveAccounts();
    localStorage.setItem('eco_meta_active', String(this._activeIdx));
    this._syncActive();
  }

  /** Troca a conta ativa pelo index. */
  switchAccount (idx) {
    if (idx < 0 || idx >= this._accounts.length) return;
    this._activeIdx = idx;
    localStorage.setItem('eco_meta_active', String(idx));
    this._syncActive();
  }

  hasCredentials () { return !!(this._token && this._accountId); }
  hasAccounts ()    { return this._accounts.length > 0; }

  // ── Core fetch ─────────────────────────────────────────
  async _get (path, params = {}) {
    const url = new URL(`${this.base}/${path}`);
    url.searchParams.set('access_token', this._token);
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    });
    const r    = await fetch(url.toString());
    const data = await r.json();
    if (data.error) throw new Error(`Meta API [${data.error.code}]: ${data.error.message}`);
    return data;
  }

  // ── Batch API (até 50 chamadas por request) ──────────
  async _batch (requests) {
    const results = [];
    const chunks  = [];
    for (let i = 0; i < requests.length; i += 50) chunks.push(requests.slice(i, i + 50));
    for (const chunk of chunks) {
      const body = new URLSearchParams({ access_token: this._token, batch: JSON.stringify(chunk) });
      const r    = await fetch(this.base, { method: 'POST', body });
      const data = await r.json();
      if (Array.isArray(data)) {
        data.forEach(resp => {
          try { results.push(resp?.code === 200 ? JSON.parse(resp.body) : null); }
          catch { results.push(null); }
        });
      }
    }
    return results;
  }

  // ── Campanhas ──────────────────────────────────────────
  async getCampaigns ({ datePreset = 'this_month' } = {}) {
    const data = await this._get(`${this._accountId}/campaigns`, {
      fields      : 'id,name,status,objective,daily_budget,lifetime_budget',
      limit       : 100,
      date_preset : datePreset,
    });
    return data.data || [];
  }

  async getCampaignInsights (campaignId, datePreset = 'this_month') {
    try {
      const data = await this._get(`${campaignId}/insights`, {
        fields : [
          'spend','impressions','reach','clicks',
          'ctr','cpc','actions','cost_per_action_type',
          'frequency','date_start','date_stop',
        ].join(','),
        date_preset : datePreset,
      });
      return data.data?.[0] || null;
    } catch (e) {
      console.warn(`Insights campaign ${campaignId}:`, e.message);
      return null;
    }
  }

  // ── Anúncios & Criativos ───────────────────────────────
  async getCampaignAds (campaignId) {
    const data = await this._get(`${campaignId}/ads`, {
      fields : [
        'id','name','status',
        'creative{id,thumbnail_url,image_url,body,title,object_type,effective_object_story_id}',
      ].join(','),
      limit : 100,
    });
    return data.data || [];
  }

  async batchAdInsights (adIds, datePreset = 'this_month') {
    if (!adIds.length) return {};
    const insightsFields = [
      'spend','impressions','reach','clicks',
      'ctr','cpc','actions','cost_per_action_type','frequency',
    ].join(',');
    const requests  = adIds.map(id => ({
      method       : 'GET',
      relative_url : `${id}/insights?fields=${insightsFields}&date_preset=${datePreset}`,
    }));
    const responses = await this._batch(requests);
    const map       = {};
    adIds.forEach((id, i) => { map[id] = responses[i]?.data?.[0] || null; });
    return map;
  }

  // ── Top 5 Criativos por campanha ──────────────────────
  async getTop5Creatives (campaignId, datePreset = 'this_month') {
    const ads = await this.getCampaignAds(campaignId);
    if (!ads.length) return [];
    const insightsMap = await this.batchAdInsights(ads.map(a => a.id), datePreset);
    const enriched = ads.map(ad => ({
      ...ad,
      insights    : insightsMap[ad.id] || null,
      results     : this._extractResults(insightsMap[ad.id]),
      spend       : parseFloat(insightsMap[ad.id]?.spend       || 0),
      ctr         : parseFloat(insightsMap[ad.id]?.ctr         || 0),
      cpc         : parseFloat(insightsMap[ad.id]?.cpc         || 0),
      impressions : parseInt  (insightsMap[ad.id]?.impressions || 0),
      frequency   : parseFloat(insightsMap[ad.id]?.frequency   || 0),
      thumbnail   : this._getThumbnail(ad),
    }));
    return enriched
      .filter(a => a.insights)
      .sort((a, b) => b.results - a.results || b.spend - a.spend)
      .slice(0, 5);
  }

  _extractResults (insights) {
    if (!insights) return 0;
    const actions = insights.actions;
    if (!actions || !actions.length) return parseFloat(insights.clicks || 0);
    const priority = [
      'lead',
      'offsite_conversion.fb_pixel_lead',
      'onsite_conversion.messaging_conversation_started_7d',
      'onsite_conversion.lead_grouped',
      'contact',
      'omni_initiated_checkout',
    ];
    for (const type of priority) {
      const a = actions.find(x => x.action_type === type);
      if (a) return parseFloat(a.value) || 0;
    }
    return Math.max(...actions.map(x => parseFloat(x.value || 0)));
  }

  _getThumbnail (ad) {
    if (!ad.creative) return null;
    return ad.creative.thumbnail_url || ad.creative.image_url || null;
  }

  // ── Validação do token ─────────────────────────────────
  async validateToken () {
    try {
      const data = await this._get('me', { fields: 'id,name' });
      return { valid: true, name: data.name, id: data.id };
    } catch (e) {
      return { valid: false, error: e.message };
    }
  }
}

// ═══════════════════════════════════════════════════════
// CLAUDE AI ANALYSIS MODULE
// ═══════════════════════════════════════════════════════
class ClaudeAIModule {
  constructor () {
    this._key  = localStorage.getItem('eco_claude_key') || '';
    this.model = 'claude-sonnet-4-20250514';
  }

  saveKey (key) {
    this._key = key.trim();
    localStorage.setItem('eco_claude_key', this._key);
  }

  hasKey () { return !!this._key; }

  async _call (prompt, maxTokens = 1200) {
    if (!this._key) throw new Error('Claude API Key não configurada. Adicione em ⚙️ Config. de API.');
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method  : 'POST',
      headers : {
        'Content-Type'                             : 'application/json',
        'x-api-key'                                : this._key,
        'anthropic-version'                        : '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model      : this.model,
        max_tokens : maxTokens,
        messages   : [{ role: 'user', content: prompt }],
      }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error?.message || `HTTP ${r.status}`);
    }
    const data = await r.json();
    return data.content?.map(b => b.text || '').join('') || '';
  }

  async analyzeCreatives (campaignName, creatives) {
    const fmt = n => parseFloat(n || 0);
    const prompt = `Você é especialista sênior em criativos de Meta Ads para o mercado imobiliário brasileiro.

CAMPANHA: "${campaignName}"

TOP ${creatives.length} CRIATIVOS — ordenados por resultados:
${creatives.map((c, i) => `
#${i + 1} — "${c.name}" [${c.status === 'ACTIVE' ? '🟢 Ativo' : '🔴 Pausado'}]
  • Gasto: R$${fmt(c.spend).toFixed(2)}
  • Impressões: ${parseInt(c.impressions || 0).toLocaleString('pt-BR')}
  • CTR: ${fmt(c.ctr).toFixed(2)}%
  • CPC: R$${fmt(c.cpc).toFixed(2)}
  • Resultados: ${c.results}
  • Frequência: ${fmt(c.frequency).toFixed(1)}
  • Custo/Resultado: ${c.results > 0 ? 'R$' + (fmt(c.spend) / c.results).toFixed(2) : '—'}
`).join('')}

Forneça análise concisa e técnica:

**1. 🏆 MELHOR CRIATIVO:** Qual (#X) e por quê (2-3 linhas baseadas em dados)
**2. ⚠️ PAUSAR:** Quais criativos pausar e motivo objetivo
**3. 💡 TESTAR AGORA:** 3 hipóteses de novos criativos baseadas nos dados
**4. 📊 SCORES (0-10):**
  #1: X/10 — [motivo curto]
  #2: X/10 — [motivo curto]
  (continue para todos)

Linguagem técnica, direta. Foque em dados, não em suposições subjetivas.`;
    return await this._call(prompt, 900);
  }

  async analyzeCampaignPerformance (campaigns) {
    const fmt = n => parseFloat(n || 0);
    const prompt = `Analise a performance global das campanhas Meta Ads da Ecovita Construtora:

${campaigns.map(c => {
  const ins = c.insights;
  return `
Campanha: "${c.name}" [${c.status}] — Objetivo: ${c.objective || '—'}
  • Gasto: R$${fmt(ins?.spend).toFixed(2)}
  • Impressões: ${parseInt(ins?.impressions || 0).toLocaleString('pt-BR')}
  • CTR: ${fmt(ins?.ctr).toFixed(2)}%
  • CPC: R$${fmt(ins?.cpc).toFixed(2)}
  • Resultados: ${c.results || 0}
  • Frequência: ${fmt(ins?.frequency).toFixed(1)}
  • Custo/Resultado: ${(c.results > 0 && ins?.spend) ? 'R$' + (fmt(ins.spend) / c.results).toFixed(2) : '—'}`;
}).join('')}

Forneça:
**1. 📊 DIAGNÓSTICO GERAL** — 2-3 linhas sobre a saúde da conta
**2. 🏆 TOP 3 MAIS EFICIENTES** — Por quê cada uma está performando bem
**3. 🚨 ATENÇÃO URGENTE** — Campanhas que precisam de ação imediata
**4. 💰 REDISTRIBUIÇÃO DE BUDGET** — Percentual recomendado por campanha/objetivo
**5. 🧪 PRÓXIMOS TESTES A/B** — 3 experimentos prioritários para a semana

Seja técnico, direto e baseado nos dados apresentados.`;
    return await this._call(prompt, 1100);
  }

  async analyzeCreative (adName, metrics) {
    const prompt = `Analise este criativo Meta Ads para mercado imobiliário:

Nome: "${adName}"
Gasto: R$${parseFloat(metrics.spend || 0).toFixed(2)}
CTR: ${parseFloat(metrics.ctr || 0).toFixed(2)}%
CPC: R$${parseFloat(metrics.cpc || 0).toFixed(2)}
Resultados: ${metrics.results || 0}
Frequência: ${parseFloat(metrics.frequency || 0).toFixed(1)}

Em 3-4 linhas: está bom ou ruim? O que melhorar? Vale escalar o budget?`;
    return await this._call(prompt, 400);
  }
}

// ═══════════════════════════════════════════════════════
// HELPERS DE FORMATAÇÃO
// ═══════════════════════════════════════════════════════
window.metaFmt = {
  brl : v => parseFloat(v || 0).toLocaleString('pt-BR', {
    style              : 'currency',
    currency           : 'BRL',
    maximumFractionDigits: 2,
  }),
  brlShort : v => {
    const n = parseFloat(v || 0);
    if (Math.abs(n) >= 1e6) return 'R$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return 'R$' + (n / 1e3).toFixed(0) + 'k';
    return 'R$' + n.toFixed(0);
  },
  num : v => parseInt(v || 0).toLocaleString('pt-BR'),
  pct : v => parseFloat(v || 0).toFixed(2) + '%',
  scoreColor : s => s >= 7 ? '#2ecc8e' : s >= 5 ? '#f5a623' : '#f06565',
};

// ═══════════════════════════════════════════════════════
// EXPOSE GLOBALS
// ═══════════════════════════════════════════════════════
window.MetaAPI  = new MetaAPIClient();
window.AIModule = new ClaudeAIModule();

console.log(
  '%c✅ Ecovita app.js v2.0 carregado — multi-conta ativo',
  'color:#2ecc8e;font-weight:bold;font-size:13px',
);
