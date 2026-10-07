/* =====================================================================
   UniMind Dashboard — app.js (Advanced Mental Health Analytics Engine)
   Works with index.html + style.css (no build step, vanilla JS).

   Modules
     1. SafetyGuard     anonymizeData(), detectCrisisKeywords()
     2. AnalyticsEngine analyzeSentiment(), calculateComplexStressScore()
     3. ActionPlanner   generateStudyPlan(), generatePersonalizedAdvice()
     4. HistoryStore + ChartView   localStorage history and Chart.js graph
     5. App             UI renderer, loading simulation, exportJSON()

   Privacy: the raw free text and the nickname are never stored or exported.
   ===================================================================== */
(function () {
  'use strict';

  /* ---------------------------------------------------------------
     CONFIG
     --------------------------------------------------------------- */
  const CONFIG = {
    startTime: '09:00',                    // first slot of the study plan
    historyKey: 'unimind.history.v1',
    historyLimit: 7,                       // keep the latest 7 assessments
    workloadCapacity: 8,                   // tasks/week treated as a "full" load
    stageMs: 500,                          // 3 stages x 500 ms = 1.5 s simulated loading
    stages: ['Anonymizing Data...', 'Analyzing Sentiment...', 'Generating Plan...']
  };

  const MOOD_LABELS = { 5: 'สดใส', 4: 'ปกติ', 3: 'เหนื่อยล้า', 2: 'เครียดมาก', 1: 'ท้อแท้' };
  const MOOD_FACTOR = { 5: 0, 4: 0.2, 3: 0.55, 2: 0.85, 1: 1 };   // 0 = calm, 1 = most strained

  const TIER_TH    = { Low: 'ต่ำ', Medium: 'ปานกลาง', High: 'สูง', Critical: 'วิกฤต' };
  const TIER_CLASS = { Low: 'level-low', Medium: 'level-medium', High: 'level-high', Critical: 'level-high' };
  const TIER_COLOR = { Low: '#0D9488', Medium: '#D99A2B', High: '#E0745F', Critical: '#C2410C' };
  const TIER_HINT  = {
    Low: 'อยู่ในเกณฑ์ที่ดูแลตัวเองได้',
    Medium: 'เริ่มสะสม ควรวางแผนพักให้ชัดเจน',
    High: 'ควรลดภาระและคุยกับผู้เชี่ยวชาญ',
    Critical: 'ควรขอความช่วยเหลือจากผู้เชี่ยวชาญโดยเร็ว'
  };

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const delay = ms => new Promise(r => setTimeout(r, ms));
  const $ = id => document.getElementById(id);

  /* =================================================================
     1. DATA ANONYMIZATION & SAFETY GUARDRAILS
     ================================================================= */
  const CRISIS_KEYWORDS = [
    'ไม่อยากอยู่', 'ท้อแท้ที่สุด', 'ไม่ไหวแล้ว', 'อยากตาย', 'ฆ่าตัวตาย', 'ทำร้ายตัวเอง',
    'ไม่อยากมีชีวิต', 'หายไปจากโลก', 'จบชีวิต', 'อยากหายไป', 'ไม่อยากตื่น',
    'suicide', 'killmyself', 'wanttodie'
  ];

  class SafetyGuard {
    /**
     * Remove personally identifiable information.
     * Known limit: Thai has no word spacing, so a name directly followed by
     * more Thai text may remove a few extra characters (safe-side behaviour).
     * @returns {{text:string, count:number}}
     */
    static anonymizeData(text, extraNames = []) {
      let out = String(text || '');
      let count = 0;
      const swap = (re, label) => { out = out.replace(re, (...m) => { count++; return typeof label === 'function' ? label(...m) : label; }); };

      swap(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[อีเมล]');                                    // emails
      swap(/(?:\+66|\b0)\d{1,2}[-\s]?\d{3}[-\s]?\d{3,4}\b/g, '[เบอร์โทร]');                // Thai phone numbers
      swap(/\b\d[\d-]{6,15}\d\b/g, '[รหัส/เลขประจำตัว]');                                   // student / national IDs
      swap(/(ไลน์|line|ไอจี|ig|อินสตาแกรม)\s*(?:id)?\s*[:：]?\s*@?[\w.]{3,}/gi, (m, p1) => `${p1} [ช่องทางโซเชียล]`);
      swap(/(ชื่อ(?:เล่น)?)\s*(?!วิชา|เสียง|โปรเจกต์)[ก-๙A-Za-z]{2,12}/g, (m, p1) => `${p1}[ชื่อ]`);
      swap(/(นางสาว|นาย|นาง|น\.ส\.|ดร\.|ผศ\.|รศ\.)\s*[ก-๙]{2,8}(?:\s+[ก-๙]{2,10})?/g, (m, p1) => `${p1}[ชื่อ]`);
      swap(/(อาจารย์|อ\.|คุณ|พี่|น้อง)\s*(?!ชาย|สาว|คน|ที่|ๆ)[ก-๙]{2,8}/g, (m, p1) => `${p1}[ชื่อ]`);
      swap(/\b[A-Z][a-z]{2,}\s+[A-Z][a-z]{2,}\b/g, '[ชื่อ]');                              // "John Smith"

      extraNames.filter(n => n && n.trim().length > 1).forEach(n => {
        const esc = n.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        swap(new RegExp(esc, 'gi'), '[ชื่อ]');
      });
      return { text: out, count };
    }

    /** Pure check, returns the matched keywords (empty array = safe). */
    static detectCrisisKeywords(text) {
      const t = String(text || '').toLowerCase().replace(/[\s\u200b]+/g, '');
      const matches = CRISIS_KEYWORDS.filter(k => t.includes(k));
      return { detected: matches.length > 0, matches };
    }
  }

  /* =================================================================
     2. NLP SENTIMENT & STRESS ALGORITHM
     ================================================================= */
  // [term, weight]. Terms starting with "ไม่" are fixed phrases and are never negated.
  const NEGATIVE_TERMS = [
    ['เครียด', 1], ['กังวล', 1], ['กลัว', 1], ['เหนื่อย', 1], ['ท้อ', 2], ['หมดแรง', 2],
    ['กดดัน', 1], ['เศร้า', 1.5], ['เหงา', 1], ['เบื่อ', 1], ['ร้องไห้', 1.5], ['สอบตก', 1.5],
    ['หงุดหงิด', 1], ['ผิดหวัง', 1], ['สับสน', 1], ['กลุ้ม', 1], ['ว้าวุ่น', 1],
    ['ไม่ไหว', 2], ['นอนไม่หลับ', 1.5], ['ส่งงานไม่ทัน', 1.5], ['ไม่เข้าใจ', 1], ['ไม่มีแรง', 1.5]
  ];
  const POSITIVE_TERMS = [
    ['ความสุข', 1.5], ['ดีใจ', 1.5], ['สบาย', 1], ['สนุก', 1], ['ผ่อนคลาย', 1.5], ['มั่นใจ', 1],
    ['ภูมิใจ', 1.5], ['โล่ง', 1], ['สดชื่น', 1], ['กำลังใจ', 1], ['ขอบคุณ', 1], ['สำเร็จ', 1],
    ['ดีขึ้น', 1.5], ['พร้อม', 0.5]
  ];

  class AnalyticsEngine {
    static scanLexicon(text) {
      const t = String(text || '').toLowerCase().replace(/[\s\u200b]+/g, '');
      let pos = 0, neg = 0;
      const scan = (list, sign) => list.forEach(([term, w]) => {
        const fixedPhrase = term.startsWith('ไม่') || term.includes('ไม่');
        let i = t.indexOf(term);
        while (i !== -1) {
          // Simple negation heuristic: "ไม่" within 7 characters before the term flips polarity
          const negated = !fixedPhrase && t.slice(Math.max(0, i - 7), i).includes('ไม่');
          const side = negated ? -sign : sign;
          if (side > 0) pos += w; else neg += w;
          i = t.indexOf(term, i + term.length);
        }
      });
      scan(POSITIVE_TERMS, +1);
      scan(NEGATIVE_TERMS, -1);
      return { pos, neg, hits: pos + neg };
    }

    /** Sentiment score from -1.0 (very negative) to +1.0 (very positive). */
    static analyzeSentiment(text) {
      const { pos, neg, hits } = AnalyticsEngine.scanLexicon(text);
      const score = clamp((pos - neg) / (pos + neg + 0.5), -1, 1);
      return { score: Math.round(score * 100) / 100, hasSignal: hits > 0 };
    }

    /**
     * Weighted Stress Index (0-100).
     *   Mood 30% + Workload ratio 30% + Sleep deficit 20% + Text sentiment 20%
     * If the text has no sentiment keywords, the sentiment slot mirrors the
     * mood factor so an empty textbox does not distort the score.
     */
    static calculateComplexStressScore({ mood, tasks, sleep, sentiment, hasSentimentSignal }) {
      const moodFactor     = MOOD_FACTOR[mood] ?? 0.5;
      const workloadRatio  = clamp(tasks / CONFIG.workloadCapacity, 0, 1);
      const sleepDeficit   = sleep > 10 ? 0.2 : clamp((8 - sleep) / 5, 0, 1);   // 3 h or less = full deficit
      const sentimentFactor = hasSentimentSignal ? (1 - sentiment) / 2 : moodFactor;

      const parts = {
        mood:      +(moodFactor * 30).toFixed(1),
        workload:  +(workloadRatio * 30).toFixed(1),
        sleep:     +(sleepDeficit * 20).toFixed(1),
        sentiment: +(sentimentFactor * 20).toFixed(1)
      };
      const score = clamp(Math.round(parts.mood + parts.workload + parts.sleep + parts.sentiment), 0, 100);
      return { score, parts };
    }

    /** Academic Burnout Risk: Low | Medium | High | Critical */
    static classifyBurnout(score, { tasks, sleep, crisis }) {
      if (crisis || score > 75) return 'Critical';
      let tier = score > 55 ? 'High' : score > 30 ? 'Medium' : 'Low';
      if (tasks >= 6 && sleep < 5 && tier !== 'High') tier = tier === 'Low' ? 'Medium' : 'High';  // overload escalation
      return tier;
    }
  }

  /* =================================================================
     3. CONTEXTUAL ACTION PLANNER
     ================================================================= */
  const PLAN_RULES = {
    Low:      { focus: 25, rest: 5,  min: 4, max: 8, mind: null,
                goal: 'รักษาจังหวะเดิม และทบทวนบทเรียนที่ค้างให้ครบ' },
    Medium:   { focus: 25, rest: 5,  min: 3, max: 6, mind: { label: 'Mindfulness: หายใจลึก 4-4-6', min: 3, every: 2 },
                goal: 'เรียงงานตามกำหนดส่ง และทำงานที่เร่งที่สุดให้เสร็จ 1 อย่าง' },
    High:     { focus: 20, rest: 10, min: 2, max: 5, mind: { label: 'Mindfulness: สแกนร่างกายและผ่อนคลายไหล่', min: 5, every: 2 },
                goal: 'ทำเพียง 2-3 งานสำคัญที่สุด แล้วพักให้ครบทุกช่วง' },
    Critical: { focus: 20, rest: 10, min: 2, max: 3, mind: { label: 'Mindfulness: หายใจช้า ๆ และฟังเสียงรอบตัว', min: 10, every: 1 },
                opening: 'เริ่มต้นด้วยการหายใจช้า ๆ และดื่มน้ำ',
                goal: 'เป้าหมายวันนี้คือดูแลตัวเองก่อน ทำงานเท่าที่ไหว และนัดคุยกับผู้เชี่ยวชาญ' }
  };

  class ActionPlanner {
    static generateStudyPlan(stressLevel, taskCount, startTime = CONFIG.startTime) {
      const rule = PLAN_RULES[stressLevel] || PLAN_RULES.Medium;
      const rounds = clamp(Math.round(taskCount) * 2, rule.min, rule.max);
      const [h, m] = startTime.split(':').map(Number);
      let t = h * 60 + m;
      const blocks = [];
      const fmt = x => String(Math.floor(x / 60) % 24).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0');
      const add = (label, minutes, type) => { blocks.push({ start: fmt(t), label, minutes, type }); t += minutes; };

      if (rule.opening) add(rule.opening, 10, 'mindful');
      for (let i = 1; i <= rounds; i++) {
        add(`อ่าน/ทำงาน รอบที่ ${i}`, rule.focus, 'study');
        if (i === rounds) break;
        const long = i % 4 === 0;
        add(long ? 'พักยาว: เดิน ดื่มน้ำ ยืดเส้น' : 'พักสั้น: ลุกยืน หลับตา พักสายตา', long ? 20 : rule.rest, 'rest');
        if (rule.mind && i % rule.mind.every === 0) add(rule.mind.label, rule.mind.min, 'mindful');
      }
      add('ปิดวัน: เขียนสิ่งที่ทำได้ 1 อย่าง แล้วเตรียมเข้านอนให้ตรงเวลา', 10, 'rest');
      return { tier: stressLevel, focusMinutes: rule.focus, restMinutes: rule.rest, rounds, goal: rule.goal, blocks };
    }

    /** Returns an array of short paragraphs (no names, safe to export). */
    static generatePersonalizedAdvice(stressLevel, sentimentScore, ctx = {}) {
      const out = [];
      const base = {
        Low: 'ภาพรวมวันนี้ค่อนข้างสมดุล รักษาจังหวะนี้ไว้ และให้รางวัลเล็ก ๆ กับตัวเองหลังทำงานเสร็จ',
        Medium: 'คุณเริ่มมีความตึงเครียดสะสม แต่ยังจัดการได้ การพักสั้น ๆ สม่ำเสมอจะช่วยกันไม่ให้ไปถึงจุดหมดแรง',
        High: 'ตอนนี้ร่างกายและใจกำลังรับน้ำหนักเกินกำลัง ไม่ใช่เพราะคุณอ่อนแอ แต่เพราะโหลดมันเยอะจริง ๆ ลองลดเป้าหมายวันนี้ให้เหลือเฉพาะสิ่งสำคัญที่สุด',
        Critical: 'ความเครียดของคุณอยู่ในระดับที่ไม่ควรแบกคนเดียว ขอให้พักงานที่ไม่เร่งด่วนไว้ก่อน และคุยกับคนที่ไว้ใจหรือนักจิตวิทยาของมหาวิทยาลัยวันนี้'
      };
      out.push(base[stressLevel] || base.Medium);

      if (sentimentScore <= -0.3) out.push('ข้อความที่คุณเขียนสะท้อนความรู้สึกหนักใจอยู่พอสมควร การได้เขียนออกมาถือเป็นก้าวที่ดี ลองเล่าให้เพื่อนสนิทหรือคนในครอบครัวฟังต่ออีกสัก 10 นาที');
      else if (sentimentScore >= 0.3) out.push('ในข้อความของคุณมีความรู้สึกดี ๆ อยู่ด้วย ลองจดไว้ 1 อย่างที่ทำให้รู้สึกแบบนั้น เพื่อกลับมาอ่านเวลาเหนื่อย');

      if (ctx.sleep !== undefined && ctx.sleep < 6) out.push(`เมื่อคืนนอน ${ctx.sleep} ชม. ซึ่งน้อยกว่าที่ร่างกายต้องการ (7-9 ชม.) คืนนี้ลองเข้านอนให้เร็วขึ้น 30 นาที และวางมือถือก่อนนอน`);
      if (ctx.tasks !== undefined && ctx.tasks >= 5) out.push(`มีงานหรือวิชา ${ctx.tasks} รายการ ลองแบ่งเป็น "ส่งเร็วสุด" "คะแนนเยอะสุด" "ทำได้เร็ว" แล้วเริ่มจากกลุ่มเล็กเพื่อสร้างแรงส่ง`);
      return out;
    }
  }

  /* =================================================================
     4. HISTORICAL DATA (localStorage) & CHART.JS
     ================================================================= */
  class HistoryStore {
    constructor(key, limit) { this.key = key; this.limit = limit; this.memory = []; }

    load() {
      try {
        const arr = JSON.parse(localStorage.getItem(this.key) || '[]');
        if (Array.isArray(arr)) return arr.filter(e => e && typeof e.score === 'number' && e.timestamp).slice(-this.limit);
      } catch (e) { /* storage blocked: fall back to memory */ }
      return this.memory.slice(-this.limit);
    }

    add(entry) {
      const list = this.load().concat(entry).slice(-this.limit);
      this.memory = list;
      try { localStorage.setItem(this.key, JSON.stringify(list)); } catch (e) { /* ignore */ }
      return list;
    }

    /** Average of entries from the last 7 days (includes the newest entry). */
    weeklyAverage(list, now = Date.now()) {
      const recent = list.filter(e => Date.parse(e.timestamp) >= now - 7 * 86400000);
      const pool = recent.length ? recent : list.slice(-1);
      const avg = pool.reduce((s, e) => s + e.score, 0) / (pool.length || 1);
      return { average: Math.round(avg), count: pool.length };
    }
  }

  class ChartView {
    constructor(canvasId) { this.canvasId = canvasId; this.chart = null; }

    render(current, weekly, tier) {
      const canvas = $(this.canvasId);
      if (!canvas) return;
      if (typeof Chart === 'undefined') {            // CDN blocked: leave a text fallback
        canvas.setAttribute('aria-label', `ความเครียดปัจจุบัน ${current}% ค่าเฉลี่ยสัปดาห์นี้ ${weekly.average}%`);
        return;
      }
      if (this.chart) this.chart.destroy();
      Chart.defaults.font.family = "'Prompt', 'Kanit', sans-serif";
      this.chart = new Chart(canvas, {
        type: 'bar',
        data: {
          labels: ['ความเครียดปัจจุบัน', 'ค่าเฉลี่ยสัปดาห์นี้'],
          datasets: [{
            data: [current, weekly.average],
            backgroundColor: [TIER_COLOR[tier], '#93C5FD'],
            borderRadius: 10,
            maxBarThickness: 90
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: { y: { min: 0, max: 100, ticks: { callback: v => v + '%' }, grid: { color: '#E2E8F0' } }, x: { grid: { display: false } } },
          plugins: {
            legend: { display: false },
            title: { display: true, text: `เทียบกับค่าเฉลี่ย 7 วัน (${weekly.count} ครั้ง)`, color: '#64748B', font: { weight: '400' } },
            tooltip: { callbacks: { label: ctx => ` ${ctx.parsed.y}%` } }
          }
        }
      });
    }
  }

  /* =================================================================
     5. UI RENDERER, LOADING SIMULATION, JSON EXPORT
     ================================================================= */
  const RUNTIME_CSS = `
    .btn-secondary{display:inline-flex;align-items:center;gap:.5rem;font:inherit;font-weight:600;color:var(--teal-dark,#0B7A70);background:#fff;border:1.5px solid var(--teal,#0D9488);border-radius:999px;padding:.65rem 1.4rem;cursor:pointer;transition:background-color .2s,transform .15s}
    .btn-secondary:hover{background:var(--teal-tint,#CCFBF1);transform:translateY(-1px)}
    .btn-secondary:active{transform:scale(.98)}
    .export-actions{display:flex;justify-content:flex-end}
    .crisis-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:1rem;background:rgba(51,65,85,.55)}
    .crisis-overlay[hidden]{display:none!important}
    .crisis-dialog{width:100%;max-width:30rem;background:#FFF7ED;border:2px solid #FDBA74;border-radius:18px;padding:1.5rem;color:#7C2D12;box-shadow:0 20px 50px rgba(0,0,0,.25);font-family:inherit}
    .crisis-dialog h2{margin:0 0 .5rem;font-size:1.25rem}
    .crisis-dialog p{margin:0 0 .75rem;line-height:1.7}
    .crisis-actions{display:flex;flex-wrap:wrap;gap:.6rem;margin-top:1rem}
    .crisis-call{display:inline-block;background:#C2410C;color:#fff;text-decoration:none;font-weight:700;border-radius:999px;padding:.6rem 1.3rem}
    .crisis-call.alt{background:#fff;color:#9A3412;border:1.5px solid #FDBA74}
    .crisis-close{font:inherit;background:transparent;border:1.5px solid #FDBA74;color:#9A3412;border-radius:999px;padding:.6rem 1.3rem;cursor:pointer}
    .schedule-table tbody tr.is-mindful td:first-child{box-shadow:inset 3px 0 0 #93C5FD}
    body.modal-open{overflow:hidden}`;

  class App {
    constructor() {
      this.history = new HistoryStore(CONFIG.historyKey, CONFIG.historyLimit);
      this.chartView = new ChartView('stressChart');
      this.report = null;
      this.busy = false;
      this.lastFocus = null;
    }

    init() {
      this.form = $('assessmentForm');
      if (!this.form) return;
      this.injectRuntimeUI();
      this.form.addEventListener('submit', e => this.handleSubmit(e));
      ['taskCount', 'sleepHours'].forEach(id => $(id).addEventListener('input', e => e.target.setCustomValidity('')));
      $('exportBtn').addEventListener('click', () => this.exportJSON());
    }

    /* ---------- runtime UI that index.html does not contain ---------- */
    injectRuntimeUI() {
      const style = document.createElement('style');
      style.id = 'unimind-runtime-styles';
      style.textContent = RUNTIME_CSS;
      document.head.appendChild(style);

      // Export button, placed after the schedule card
      const wrap = document.createElement('div');
      wrap.className = 'export-actions';
      wrap.innerHTML = '<button type="button" class="btn-secondary" id="exportBtn">ดาวน์โหลดรายงาน (JSON)</button>';
      const schedule = $('scheduleCard');
      schedule.parentNode.insertBefore(wrap, schedule.nextSibling);

      // Crisis alert modal
      const modal = document.createElement('div');
      modal.className = 'crisis-overlay';
      modal.id = 'crisisModal';
      modal.hidden = true;
      modal.innerHTML = `
        <div class="crisis-dialog" role="alertdialog" aria-modal="true" aria-labelledby="crisisTitle" aria-describedby="crisisDesc">
          <h2 id="crisisTitle">เราเป็นห่วงคุณ</h2>
          <p id="crisisDesc">ข้อความของคุณมีถ้อยคำที่สะท้อนความทุกข์หนักมาก คุณไม่ต้องรับมือคนเดียว กรุณาโทรหาสายด่วนสุขภาพจิต <strong>1323</strong> (24 ชั่วโมง) หรือบอกคนที่ไว้ใจให้มาอยู่ด้วยตอนนี้</p>
          <p>หากรู้สึกว่าตัวเองหรือผู้อื่นอยู่ในอันตรายทันที โทร <strong>1669</strong></p>
          <div class="crisis-actions">
            <a class="crisis-call" href="tel:1323" id="crisisCall">โทร 1323</a>
            <a class="crisis-call alt" href="tel:1669">โทร 1669</a>
            <button type="button" class="crisis-close" id="crisisClose">รับทราบ</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
      $('crisisClose').addEventListener('click', () => this.closeCrisisModal());
      modal.addEventListener('keydown', e => this.trapModalKeys(e));
    }

    showCrisisModal() {
      this.lastFocus = document.activeElement;
      $('crisisModal').hidden = false;
      document.body.classList.add('modal-open');
      $('crisisCall').focus();
    }

    closeCrisisModal() {
      $('crisisModal').hidden = true;
      document.body.classList.remove('modal-open');
      if (this.lastFocus && this.lastFocus.focus) this.lastFocus.focus();
    }

    trapModalKeys(e) {
      if (e.key === 'Escape') { this.closeCrisisModal(); return; }
      if (e.key !== 'Tab') return;
      const items = $('crisisModal').querySelectorAll('a[href], button');
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }

    /* ---------- input reading / validation ---------- */
    readInputs() {
      const num = (id, lo, hi, msg) => {
        const el = $(id);
        const v = el.value.trim() === '' ? NaN : Number(el.value);
        if (!Number.isFinite(v)) { el.setCustomValidity(msg); el.reportValidity(); return null; }
        return clamp(v, lo, hi);
      };
      const tasks = num('taskCount', 0, 20, 'กรุณากรอกจำนวนงานเป็นตัวเลข');
      if (tasks === null) return null;
      const sleep = num('sleepHours', 0, 24, 'กรุณากรอกชั่วโมงนอนเป็นตัวเลข');
      if (sleep === null) return null;
      const checked = this.form.querySelector('input[name="mood"]:checked');
      return {
        nickname: $('nickname').value.trim(),
        mood: checked ? Number(checked.value) : 4,
        tasks: Math.round(tasks),
        sleep,
        rawText: $('worryText').value
      };
    }

    setLoading(on, label) {
      const btn = $('submitBtn');
      btn.disabled = on;
      btn.classList.toggle('is-loading', on);
      $('loadingSpinner').hidden = !on;
      $('btnLabel').textContent = label;
    }

    /* ---------- main pipeline ---------- */
    async handleSubmit(e) {
      e.preventDefault();
      if (this.busy) return;
      const input = this.readInputs();
      if (!input) return;
      this.busy = true;

      // Safety first: check the original text and show the modal immediately
      const crisis = SafetyGuard.detectCrisisKeywords(input.rawText);
      if (crisis.detected) this.showCrisisModal();

      try {
        this.setLoading(true, CONFIG.stages[0]);
        const anon = SafetyGuard.anonymizeData(input.rawText, [input.nickname]);
        await delay(CONFIG.stageMs);

        this.setLoading(true, CONFIG.stages[1]);
        const senti = AnalyticsEngine.analyzeSentiment(anon.text);
        const stress = AnalyticsEngine.calculateComplexStressScore({
          mood: input.mood, tasks: input.tasks, sleep: input.sleep,
          sentiment: senti.score, hasSentimentSignal: senti.hasSignal
        });
        const tier = AnalyticsEngine.classifyBurnout(stress.score, { tasks: input.tasks, sleep: input.sleep, crisis: crisis.detected });
        await delay(CONFIG.stageMs);

        this.setLoading(true, CONFIG.stages[2]);
        const plan = ActionPlanner.generateStudyPlan(tier, input.tasks);
        const advice = ActionPlanner.generatePersonalizedAdvice(tier, senti.score, { sleep: input.sleep, tasks: input.tasks });
        await delay(CONFIG.stageMs);

        // Persist only timestamp, score and mood
        const now = new Date();
        const list = this.history.add({ timestamp: now.toISOString(), score: stress.score, mood: MOOD_LABELS[input.mood] });
        const weekly = this.history.weeklyAverage(list, now.getTime());

        this.report = {
          app: 'UniMind Dashboard',
          generatedAt: now.toISOString(),
          inputs: { mood: MOOD_LABELS[input.mood], taskCount: input.tasks, sleepHours: input.sleep },
          anonymization: { replacements: anon.count },
          analysis: {
            stressScore: stress.score,
            burnoutRisk: tier,
            sentimentScore: senti.score,
            crisisKeywordDetected: crisis.detected,
            weightedBreakdown: stress.parts,
            weeklyAverage: weekly.average
          },
          studyPlan: plan,
          advice,
          history: list
        };
        this.render({ input, anon, stress, tier, senti, plan, advice, weekly, crisis });
      } catch (err) {
        console.error('UniMind error:', err);
      } finally {
        this.setLoading(false, 'ประมวลผลด้วย AI');
        this.busy = false;
      }
    }

    /* ---------- rendering ---------- */
    render({ input, anon, stress, tier, senti, plan, advice, weekly, crisis }) {
      const score = stress.score;

      // Re-trigger the CSS fade-in on every run
      const dash = $('dashboard');
      dash.hidden = true;
      void dash.offsetWidth;
      dash.hidden = false;

      // Score cards
      $('stressScore').textContent = score + '%';
      const meter = $('stressMeter');
      meter.style.width = score + '%';
      meter.style.background = TIER_COLOR[tier];
      const lvl = $('burnoutLevel');
      lvl.textContent = TIER_TH[tier];
      ['level-low', 'level-medium', 'level-high'].forEach(c => lvl.classList.remove(c));
      lvl.classList.add(TIER_CLASS[tier]);
      $('burnoutHint').textContent = TIER_HINT[tier];

      // Emergency banner: stress above 75% or crisis wording
      const showBanner = score > 75 || crisis.detected;
      $('emergencyBanner').hidden = !showBanner;
      $('emergencyMessage').textContent = crisis.detected
        ? 'ข้อความของคุณสะท้อนความทุกข์หนักมาก คุณไม่ต้องรับมือคนเดียว'
        : 'ระดับความเครียดสูงกว่า 75% หากรู้สึกรับมือไม่ไหว ติดต่อสายด่วนหรือศูนย์ให้คำปรึกษาของมหาวิทยาลัยได้ทันที';

      // Chart
      this.chartView.render(score, weekly, tier);

      // Advice (greeting uses the nickname for display only)
      const box = $('adviceContent');
      box.textContent = '';
      const lines = [`สวัสดี${input.nickname ? ' ' + input.nickname : ''} ขอบคุณที่มาเช็กความรู้สึกวันนี้`].concat(advice);
      lines.forEach((line, i) => {
        const p = document.createElement('p');
        if (i === 0) p.style.fontWeight = '500';
        p.textContent = line;
        box.appendChild(p);
      });
      $('anonText').textContent = anon.text || '(ไม่ได้กรอกข้อความ)';
      $('anonCount').textContent = `ลบข้อมูลระบุตัวตนไป ${anon.count} จุด`;

      // Schedule
      $('scheduleGoal').textContent = `เป้าหมายวันนี้: ${plan.goal} (อ่าน ${plan.focusMinutes} นาที / พัก ${plan.restMinutes} นาที)`;
      const body = $('scheduleBody');
      body.textContent = '';
      plan.blocks.forEach(b => {
        const tr = document.createElement('tr');
        tr.className = 'is-' + b.type;
        [b.start, b.label, b.minutes + ' นาที'].forEach(v => {
          const td = document.createElement('td');
          td.textContent = v;
          tr.appendChild(td);
        });
        body.appendChild(tr);
      });

      const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      dash.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    }

    /* ---------- JSON export ---------- */
    exportJSON() {
      if (!this.report) return;
      const blob = new Blob([JSON.stringify(this.report, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'unimind-report.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }

  /* ---------------------------------------------------------------
     Public API (named functions from the spec) + bootstrap
     --------------------------------------------------------------- */
  const app = new App();
  const api = {
    anonymizeData: (text, names) => SafetyGuard.anonymizeData(text, names),
    detectCrisisKeywords: text => SafetyGuard.detectCrisisKeywords(text),
    analyzeSentiment: text => AnalyticsEngine.analyzeSentiment(text).score,
    calculateComplexStressScore: inputs => AnalyticsEngine.calculateComplexStressScore(inputs),
    generateStudyPlan: (level, tasks) => ActionPlanner.generateStudyPlan(level, tasks),
    generatePersonalizedAdvice: (level, sentiment, ctx) => ActionPlanner.generatePersonalizedAdvice(level, sentiment, ctx),
    exportJSON: () => app.exportJSON()
  };
  window.UniMind = api;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => app.init());
  else app.init();
})();
