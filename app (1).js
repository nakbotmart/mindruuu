/* ==========================================================================
   UniMind Pro — app.js
   Academic Mental Health & Performance Analytics Dashboard (Vanilla JS)

   Modules
   1. SafetyGuardrails   : anonymizeInput(), detectCrisisKeywords(), CrisisBanner
   2. StressEngine       : Psychometric / Sentiment / Stress Index / Burnout Risk
   3. ScheduleAdvisor    : generateAdaptiveSchedule(), generateAdviceMessage()
   4. ChartManager       : Radar + Trend charts (Chart.js)  |  HistoryStore (localStorage)
   5. JSONExporter       : exportJSONReport()  |  SimulationHandler (loading state)

   หมายเหตุ: ผลลัพธ์เป็นเพียงเครื่องมือคัดกรองเบื้องต้น ไม่ใช่การวินิจฉัยทางการแพทย์
   ========================================================================== */

(function () {
  'use strict';

  /* ------------------------------------------------------------------------
     CONFIG & SHARED HELPERS
     ------------------------------------------------------------------------ */
  const CONFIG = Object.freeze({
    STORAGE_KEY: 'unimindpro_history_v1',
    MAX_HISTORY: 7,
    HOTLINE: '1323',
    CRISIS_STRESS_THRESHOLD: 75,
    WORKLOAD_MAX: 10,          // จำนวนงาน/สอบที่ถือว่า "เต็มสเกล" (Workload_Ratio = 1.0)
    SLEEP_RECOMMENDED: 8,      // ชั่วโมงนอนที่แนะนำ (Sleep_Deficit = 0)
    SLEEP_MINIMUM: 3,          // นอนน้อยกว่านี้ถือว่า Sleep_Deficit = 1.0
    SIMULATION_TOTAL_MS: 1500, // เวลารวมของ Loading Simulation
    DEBOUNCE_MS: 350,
    WEIGHTS: Object.freeze({ PSYCHOMETRIC: 3.5, WORKLOAD: 20, SLEEP: 15, SENTIMENT: 10 })
  });

  const SIMULATION_STEP_COUNT = 4;

  const RISK_TH = Object.freeze({
    Low: 'ต่ำ',
    Medium: 'ปานกลาง',
    High: 'สูง',
    Critical: 'วิกฤต'
  });

  const RISK_KEY = Object.freeze({
    Low: 'low',
    Medium: 'med',
    High: 'high',
    Critical: 'critical'
  });

  const RISK_COLOR = Object.freeze({
    Low: '#10B981',
    Medium: '#EAB308',
    High: '#F97316',
    Critical: '#DC2626'
  });

  const RISK_ORDER = ['Low', 'Medium', 'High', 'Critical'];

  const RADAR_LABELS = Object.freeze([
    'การนอนหลับ',
    'สมาธิ',
    'อารมณ์/ความกังวล',
    'พลังงาน/แรงจูงใจ',
    'การรับมือภาระงาน'
  ]);

  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

  const round = (n, digits = 1) => {
    const f = Math.pow(10, digits);
    return Math.round(n * f) / f;
  };

  const pad2 = (n) => String(n).padStart(2, '0');

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const $ = (id) => document.getElementById(id);

  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  const debounce = (fn, wait) => {
    let timer = null;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), wait);
    };
  };

  /** แปลงคะแนนความเครียด (%) เป็นระดับความเสี่ยง */
  function levelFromStress(stressIndex) {
    if (stressIndex > 75) return 'Critical';
    if (stressIndex > 55) return 'High';
    if (stressIndex >= 30) return 'Medium';
    return 'Low';
  }

  /** ตั้งค่า Badge ระดับความเสี่ยง (Low=เขียว, Med=เหลือง, High=ส้ม, Critical=แดง) */
  function setBadge(el, key, text) {
    if (!el) return;
    el.classList.remove('badge-low', 'badge-med', 'badge-high', 'badge-critical');
    el.classList.add('badge-' + key);
    el.textContent = text;
  }

  function formatShortDate(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '-';
    return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function formatSentiment(score) {
    return (score > 0 ? '+' : '') + score.toFixed(2);
  }


  /* ========================================================================
     MODULE 1 — ANONYMIZATION & SAFETY GUARDRAILS
     ======================================================================== */

  /** ควบคุมการแสดง/ซ่อน Crisis Alert Banner (รองรับหลายสาเหตุพร้อมกัน) */
  const CrisisBanner = {
    reasons: new Set(),

    show(reason, options) {
      const opts = options || {};
      this.reasons.add(reason);

      const el = $('crisisAlert');
      if (!el) return;

      const title = el.querySelector('h3');
      if (title) {
        title.textContent = this.reasons.has('keyword')
          ? 'พบข้อความที่อาจเกี่ยวข้องกับการทำร้ายตัวเอง — โปรดขอความช่วยเหลือทันที'
          : 'ตรวจพบระดับความเครียดสูงมาก';
      }

      el.hidden = false;

      if (opts.scroll && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    },

    clear(reason) {
      this.reasons.delete(reason);
      if (this.reasons.size === 0) {
        const el = $('crisisAlert');
        if (el) el.hidden = true;
      } else {
        // ยังมีสาเหตุอื่นอยู่ → อัปเดตหัวข้อให้ตรงกับสาเหตุที่เหลือ
        const remaining = this.reasons.values().next().value;
        this.show(remaining);
      }
    }
  };

  /** รูปแบบ PII ที่ต้องลบออกจากข้อความ (เรียงลำดับสำคัญ: เฉพาะเจาะจง → ทั่วไป) */
  const PII_PATTERNS = [
    { key: 'email',       regex: /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g,          token: '[EMAIL]' },
    { key: 'url',         regex: /(?:https?:\/\/|www\.)[^\s]+/gi,                               token: '[URL]' },
    { key: 'national_id', regex: /\b\d-?\d{4}-?\d{5}-?\d{2}-?\d\b/g,                            token: '[ID_CARD]' },
    { key: 'phone',       regex: /(?:\+66[\s\-.]?|\b0)\d{1,2}[\s\-.]?\d{3}[\s\-.]?\d{3,4}\b/g,   token: '[PHONE]' },
    { key: 'student_id',  regex: /\b\d{8,11}(?:-\d)?\b/g,                                       token: '[STUDENT_ID]' },
    { key: 'handle',      regex: /@[A-Za-z0-9_.]{3,}/g,                                         token: '[HANDLE]' }
  ];

  /**
   * คำ/วลีเสี่ยงภาวะซึมเศร้า–ทำร้ายตัวเอง
   * หมายเหตุ: เลือก "ระวังไว้ก่อน" (อาจมี false positive เช่น "ไม่อยากตาย") เพราะความปลอดภัยสำคัญกว่า
   * ข้อความถูกลบช่องว่างก่อนเทียบ จึงเขียนคำโดยไม่ต้องมีช่องว่าง
   */
  const CRISIS_KEYWORDS = [
    'อยากตาย', 'ขอตาย', 'ตายไปเลย', 'ฆ่าตัวตาย', 'ทำร้ายตัวเอง', 'กรีดข้อมือ',
    'กินยาเกินขนาด', 'กระโดดตึก', 'จบชีวิต', 'จบทุกอย่าง', 'อยากหายไป', 'หายไปจากโลก',
    'ไม่อยากมีชีวิต', 'ไม่อยากอยู่ต่อ', 'ไม่อยากอยู่แล้ว', 'ไม่อยากตื่นขึ้นมา', 'อยากหลับไม่ตื่น',
    'ชีวิตไม่มีความหมาย', 'ไม่มีเหตุผลที่จะอยู่', 'ไร้ค่าไม่มีใครต้องการ', 'หมดหวังในชีวิต',
    'suicide', 'suicidal', 'killmyself', 'endmylife', 'wanttodie', 'selfharm', 'self-harm'
  ];

  class SafetyGuardrails {
    /**
     * ลบ PII พร้อมรายงานจำนวนที่ลบ
     * @param {string} text
     * @returns {{text: string, redactions: number, byType: Object}}
     */
    static anonymizeWithStats(text) {
      const stats = { text: '', redactions: 0, byType: {} };
      if (typeof text !== 'string' || text.length === 0) return stats;

      // แปลงเลขไทยเป็นเลขอารบิกก่อน เพื่อให้ Regex จับได้ครบ
      let output = text.replace(/[๐-๙]/g, (d) => String(d.charCodeAt(0) - 0x0E50));

      PII_PATTERNS.forEach((pattern) => {
        output = output.replace(pattern.regex, () => {
          stats.redactions += 1;
          stats.byType[pattern.key] = (stats.byType[pattern.key] || 0) + 1;
          return pattern.token;
        });
      });

      stats.text = output.trim();
      return stats;
    }

    /** ลบข้อมูลส่วนบุคคล (รหัสนักศึกษา, เบอร์โทร, อีเมล ฯลฯ) ออกจากข้อความ */
    static anonymizeInput(text) {
      return SafetyGuardrails.anonymizeWithStats(text).text;
    }

    /**
     * ตรวจจับคำเสี่ยง หากพบจะเปิด Crisis Banner พร้อมสายด่วน 1323 ทันที
     * @param {string} text
     * @param {{showBanner?: boolean, scroll?: boolean}} [options]
     * @returns {{detected: boolean, keywords: string[]}}
     */
    static detectCrisisKeywords(text, options) {
      const opts = options || {};
      const showBanner = opts.showBanner !== false;
      const result = { detected: false, keywords: [] };

      if (typeof text !== 'string' || text.trim() === '') return result;

      const normalized = text.toLowerCase().replace(/\s+/g, '');
      result.keywords = CRISIS_KEYWORDS.filter((kw) => normalized.indexOf(kw) !== -1);
      result.detected = result.keywords.length > 0;

      if (result.detected && showBanner) {
        CrisisBanner.show('keyword', { scroll: !!opts.scroll });
      }
      return result;
    }
  }


  /* ========================================================================
     MODULE 2 — PSYCHOMETRIC & MULTI-VECTOR STRESS ENGINE
     ======================================================================== */

  /** Lexicon ภาษาไทย: [คำ, น้ำหนัก] (บวก = อารมณ์เชิงบวก, ลบ = อารมณ์เชิงลบ) */
  const SENTIMENT_LEXICON = (function () {
    const positive = [
      ['มีความสุข', 2], ['สุขใจ', 2], ['สบายใจ', 2], ['โล่งใจ', 2], ['ภูมิใจ', 2], ['มีความหวัง', 2], ['หายเครียด', 2],
      ['ดีใจ', 1], ['เบาใจ', 1], ['สนุก', 1], ['ยิ้ม', 1], ['หัวเราะ', 1], ['ผ่อนคลาย', 1], ['สดชื่น', 1],
      ['มั่นใจ', 1], ['กำลังใจ', 1], ['ขอบคุณ', 1], ['สำเร็จ', 1], ['สงบ', 1], ['อบอุ่น', 1],
      ['มีแรง', 1], ['โอเค', 1], ['ทำได้', 1], ['ตั้งใจ', 1], ['ปลอดภัย', 1]
    ];
    const negative = [
      ['ทนไม่ไหว', 3], ['อยากตาย', 3], ['ฆ่าตัวตาย', 3], ['ไร้ค่า', 3], ['หมดหวัง', 3], ['สิ้นหวัง', 3],
      ['ซึมเศร้า', 2], ['เศร้า', 2], ['หมดไฟ', 2], ['หมดแรง', 2], ['ท้อแท้', 2], ['ท้อใจ', 2], ['ผิดหวัง', 2],
      ['ร้องไห้', 2], ['ไม่ไหว', 2], ['นอนไม่หลับ', 2], ['เครียด', 2], ['กดดัน', 2], ['โดดเดี่ยว', 2],
      ['ล้มเหลว', 2], ['เหนื่อยล้า', 2], ['เจ็บปวด', 2], ['ทรมาน', 2],
      ['กังวล', 1], ['วิตก', 1], ['หงุดหงิด', 1], ['เหนื่อย', 1], ['เบื่อ', 1], ['โกรธ', 1],
      ['กลัว', 1], ['สับสน', 1], ['เหงา', 1], ['หนักใจ', 1], ['แย่', 1]
    ];

    const merged = [];
    positive.forEach((p) => merged.push({ word: p[0], value: p[1] }));
    negative.forEach((n) => merged.push({ word: n[0], value: -n[1] }));

    // เรียงคำยาวก่อน เพื่อให้ Longest-match ทำงาน (เช่น "หายเครียด" ก่อน "เครียด")
    merged.sort((a, b) => b.word.length - a.word.length);
    return merged;
  })();

  class StressEngine {
    /** คะแนน ST-5 รวม 0–15 จากคำตอบ 5 ข้อ (ข้อละ 0–3) */
    static calculatePsychometricScore(answers) {
      if (!Array.isArray(answers)) return 0;
      const total = answers.slice(0, 5).reduce((sum, v) => {
        const n = Number(v);
        return sum + (Number.isFinite(n) ? clamp(Math.round(n), 0, 3) : 0);
      }, 0);
      return clamp(total, 0, 15);
    }

    /**
     * Lexicon Sentiment Score (-1.0 ถึง +1.0) จากคีย์เวิร์ดภาษาไทย
     * รองรับคำปฏิเสธ เช่น "ไม่เครียด" (กลับขั้ว) และใช้ Longest-match ป้องกันการนับซ้ำ
     */
    static calculateSentiment(text) {
      const result = { score: 0, positive: 0, negative: 0, hasText: false };
      if (typeof text !== 'string' || text.trim() === '') return result;

      result.hasText = true;
      let work = text.toLowerCase();
      let pos = 0;
      let neg = 0;

      SENTIMENT_LEXICON.forEach((entry) => {
        let from = 0;
        let idx = work.indexOf(entry.word, from);

        while (idx !== -1) {
          const before = work.slice(Math.max(0, idx - 6), idx);
          const negated = /ไม่(?:ค่อย|ได้)?\s*$/.test(before);
          const value = negated ? -entry.value : entry.value;

          if (value > 0) pos += value;
          else neg += Math.abs(value);

          // Mask คำที่จับแล้ว เพื่อไม่ให้คำสั้นกว่านับซ้ำ
          work = work.slice(0, idx) + '\u0000'.repeat(entry.word.length) + work.slice(idx + entry.word.length);
          from = idx + entry.word.length;
          idx = work.indexOf(entry.word, from);
        }
      });

      result.positive = pos;
      result.negative = neg;

      // Smoothing (+1) ป้องกันคะแนนพุ่งถึง ±1 จากคำเดียว
      const score = (pos - neg) / (pos + neg + 1);
      result.score = round(clamp(score, -1, 1), 2);
      return result;
    }

    static calculateWorkloadRatio(workloadCount) {
      const n = Number(workloadCount);
      if (!Number.isFinite(n)) return 0;
      return clamp(n / CONFIG.WORKLOAD_MAX, 0, 1);
    }

    static calculateSleepDeficit(sleepHours) {
      const h = Number(sleepHours);
      if (!Number.isFinite(h)) return 0;
      const range = CONFIG.SLEEP_RECOMMENDED - CONFIG.SLEEP_MINIMUM;
      return clamp((CONFIG.SLEEP_RECOMMENDED - h) / range, 0, 1);
    }

    /**
     * Stress Index (0–100%)
     * = (Psychometric_Score * 3.5) + (Workload_Ratio * 20) + (Sleep_Deficit_Factor * 15) - (Sentiment_Score * 10)
     */
    static calculateStressIndex(input) {
      const w = CONFIG.WEIGHTS;
      const workloadRatio = StressEngine.calculateWorkloadRatio(input.workloadCount);
      const sleepDeficit = StressEngine.calculateSleepDeficit(input.sleepHours);

      const components = {
        psychometric: input.psychometricScore * w.PSYCHOMETRIC,
        workload: workloadRatio * w.WORKLOAD,
        sleep: sleepDeficit * w.SLEEP,
        sentiment: -(input.sentimentScore * w.SENTIMENT)
      };

      const raw = components.psychometric + components.workload + components.sleep + components.sentiment;

      return {
        index: round(clamp(raw, 0, 100), 1),
        raw: round(raw, 2),
        workloadRatio: round(workloadRatio, 2),
        sleepDeficit: round(sleepDeficit, 2),
        components: {
          psychometric: round(components.psychometric, 2),
          workload: round(components.workload, 2),
          sleep: round(components.sleep, 2),
          sentiment: round(components.sentiment, 2)
        }
      };
    }

    /**
     * Academic Burnout Risk: Low / Medium / High / Critical
     * - อิงจาก Stress Index
     * - ยกระดับ 1 ขั้น หากนอน < 5 ชม. และภาระงานสูง (Workload_Ratio >= 0.7)
     * - พบคำเสี่ยงในข้อความ → Critical ทันที
     */
    static classifyBurnoutRisk(stressIndex, context) {
      const ctx = context || {};
      let level = levelFromStress(stressIndex);
      let escalated = false;

      if (Number(ctx.sleepHours) < 5 && Number(ctx.workloadRatio) >= 0.7) {
        const next = RISK_ORDER[Math.min(RISK_ORDER.indexOf(level) + 1, RISK_ORDER.length - 1)];
        if (next !== level) {
          level = next;
          escalated = true;
        }
      }

      if (ctx.crisisKeyword) {
        level = 'Critical';
        escalated = true;
      }

      return { level: level, escalated: escalated };
    }
  }


  /* ========================================================================
     MODULE 3 — ADAPTIVE SCHEDULE & AI ADVICE LOGIC
     ======================================================================== */

  const SCHEDULE_PROFILES = {
    Low: {
      label: 'โหมดโฟกัสเต็มกำลัง',
      study: 45, rest: 10, rounds: 4, longBreak: 20,
      note: '',
      studyTips: [
        'เริ่มจากหัวข้อที่สำคัญที่สุดของวัน',
        'ลองสรุปเนื้อหาเป็นแผนผังความคิด',
        'ทำโจทย์หรือแบบฝึกหัดเพื่อทดสอบตัวเอง',
        'ทบทวนและจดจุดที่ยังสงสัยไว้ถามต่อ'
      ],
      restActivities: [
        'ยืดเหยียดกล้ามเนื้อคอ บ่า ไหล่ 2–3 นาที',
        'ดื่มน้ำและมองออกไปไกล ๆ ให้ดวงตาได้พัก',
        'ลุกเดินสั้น ๆ รอบห้อง',
        'หายใจลึกช้า ๆ 5 รอบ'
      ],
      longBreakTip: 'พักยาว: กินของว่างเบา ๆ และออกไปรับแสงธรรมชาติ'
    },
    Medium: {
      label: 'โหมดสมดุล',
      study: 30, rest: 10, rounds: 4, longBreak: 20,
      note: '',
      studyTips: [
        'เลือกงาน 3 อย่างที่สำคัญที่สุด แล้วทำทีละอย่าง',
        'ปิดแจ้งเตือนโทรศัพท์ระหว่างอ่าน',
        'แบ่งงานใหญ่เป็นชิ้นเล็ก ๆ ที่เสร็จใน 30 นาที',
        'จดสิ่งที่ทำสำเร็จแล้วเพื่อเพิ่มกำลังใจ'
      ],
      restActivities: [
        'หายใจแบบกล่อง (เข้า 4 – กลั้น 4 – ออก 4)',
        'ลุกเดินและยืดเส้นยืดสาย',
        'ล้างหน้าหรือจิบน้ำอุ่น',
        'ฟังเพลงเบา ๆ ที่ชอบ'
      ],
      longBreakTip: 'พักยาว: คุยกับเพื่อนหรือครอบครัวสั้น ๆ เพื่อคลายความตึงเครียด'
    },
    High: {
      label: 'โหมดผ่อนแรง',
      study: 20, rest: 10, rounds: 4, longBreak: 25,
      note: 'ปรับให้อ่านสั้นลงและพักบ่อยขึ้น เพื่อลดแรงกดดันต่อสมองและร่างกาย',
      studyTips: [
        'เลือกงานเล็กที่ทำเสร็จได้ใน 20 นาที',
        'เริ่มจากหัวข้อง่ายก่อนเพื่อสร้างความมั่นใจ',
        'วางโทรศัพท์ไว้ห่างตัวและโฟกัสทีละเรื่อง',
        'จดสิ่งที่ทำเสร็จแล้วทีละข้อ ให้รางวัลตัวเองเล็ก ๆ'
      ],
      restActivities: [
        'หายใจ 4-7-8 จำนวน 4 รอบ',
        'ฟังเพลงผ่อนคลายหรือเสียงธรรมชาติ',
        'เดินรับแสงแดดหรือเปิดหน้าต่างรับอากาศ',
        'จิบน้ำอุ่นและยืดเหยียดเบา ๆ'
      ],
      longBreakTip: 'พักยาว: อาบน้ำอุ่น เขียนระบายความรู้สึก หรือพูดคุยกับคนที่ไว้ใจ'
    },
    Critical: {
      label: 'โหมดฟื้นฟูตัวเอง',
      study: 15, rest: 10, rounds: 3, longBreak: 30,
      note: 'ช่วงนี้ให้ความสำคัญกับการพักเป็นหลัก หากรู้สึกไม่ไหว ควรหยุดและขอความช่วยเหลือ (สายด่วน 1323)',
      studyTips: [
        'ทำเพียงสิ่งที่จำเป็นที่สุดเท่านั้น',
        'อ่านเบา ๆ หรือทบทวนหัวข้อที่คุ้นเคย',
        'หยุดได้ทันทีหากรู้สึกล้า ไม่ต้องฝืน'
      ],
      restActivities: [
        'หลับตาและหายใจช้า ๆ อย่างน้อย 10 รอบ',
        'ดื่มน้ำ ล้างหน้า และนั่งพักในที่เงียบ',
        'ส่งข้อความหาคนที่ไว้ใจสักคน'
      ],
      longBreakTip: 'พักยาว: พักจากงานทั้งหมด พูดคุยกับคนที่ไว้ใจ หรือโทรสายด่วนสุขภาพจิต 1323'
    }
  };

  const ADVICE_POOLS = {
    Low: [
      '{name} ทำได้ดีมากเลยนะ ตอนนี้ระดับความเครียดยังอยู่ในเกณฑ์สบาย ๆ ลองรักษาจังหวะการเรียนและการพักแบบนี้ไว้ แล้วให้รางวัลเล็ก ๆ กับตัวเองเมื่อทำเป้าหมายสำเร็จ',
      'สัญญาณวันนี้ค่อนข้างดี {name} มีสมดุลระหว่างการเรียนกับการใช้ชีวิตอยู่ ลองใช้ช่วงที่มีแรงนี้วางแผนสัปดาห์หน้าล่วงหน้า จะช่วยให้ใจเบาลงอีก',
      'ขอชื่นชม {name} ที่ใส่ใจสุขภาพใจของตัวเองอย่างสม่ำเสมอ การเช็กอินกับตัวเองแบบนี้เป็นนิสัยที่ดีมาก ลองชวนเพื่อนสักคนมาเช็กอินด้วยกันก็ได้นะ',
      'ตอนนี้ร่างกายและใจของ {name} ยังมีพลังอยู่ ใช้โอกาสนี้สร้างนิสัยดี ๆ เช่น นอนให้พอและขยับร่างกายเบา ๆ เพื่อเป็นเกราะป้องกันในช่วงสอบหนัก'
    ],
    Medium: [
      '{name} กำลังเจอแรงกดดันอยู่บ้าง ซึ่งเป็นเรื่องปกติของชีวิตนักศึกษา ลองแบ่งงานใหญ่เป็นชิ้นเล็ก ๆ แล้วทำทีละชิ้น ความรู้สึกท่วมท้นจะค่อย ๆ ลดลง',
      'ความเครียดระดับกลางเป็นสัญญาณให้ปรับจังหวะ ไม่ได้แปลว่า {name} ทำได้ไม่ดี ลองเลือกงานสำคัญของวันนี้เพียง 3 อย่าง แล้วทำให้เสร็จทีละอย่างก็พอ',
      '{name} ไม่ต้องเก่งทุกอย่างในวันเดียวนะ พักหายใจลึก ๆ สักครู่ แล้วกลับมาทำต่อด้วยจังหวะที่สบายขึ้น ทุกก้าวเล็ก ๆ ที่เดินก็นับ',
      'ถ้ารู้สึกตึงมาก ลองเดินออกไปรับอากาศหรือคุยกับเพื่อนสัก 10 นาที การเว้นระยะจากงานช่วยให้สมองกลับมาโฟกัสได้ดีกว่าเดิม'
    ],
    High: [
      '{name} กำลังแบกรับหลายอย่างมากเลยนะ ขอบคุณที่ยังพยายามอยู่ ตอนนี้ลองลดเป้าหมายต่อวันลงและให้ความสำคัญกับการพักก่อน เพราะการพักคือส่วนหนึ่งของการเรียนรู้',
      'ระดับความเครียดตอนนี้ค่อนข้างสูง ลองหายใจเข้า 4 วินาที กลั้น 7 วินาที ออก 8 วินาที ทำซ้ำ 4 รอบ และอย่ากลัวที่จะปรึกษาอาจารย์เรื่องภาระงานนะ {name}',
      '{name} ไม่ได้อ่อนแอเลย แต่ร่างกายและใจกำลังบอกว่าต้องการการดูแล ลองเล่าให้คนที่ไว้ใจฟังสักคน เช่น เพื่อน ครอบครัว หรือนักจิตวิทยาประจำมหาวิทยาลัย',
      'งานทั้งหมดไม่จำเป็นต้องเสร็จภายในวันนี้ ลองเลือกเพียงหนึ่งอย่างที่สำคัญที่สุด แล้วปล่อยส่วนที่เหลือไว้ก่อน {name} จะรู้สึกเบาลงกว่าที่คิด'
    ],
    Critical: [
      '{name} ขอบคุณที่กล้าบอกความรู้สึกของตัวเองออกมา ตอนนี้สัญญาณความเครียดสูงมาก อยากให้พักจากงานทั้งหมดสักครู่ และติดต่อคนที่ไว้ใจหรือสายด่วนสุขภาพจิต 1323 (ตลอด 24 ชั่วโมง) ได้เลยนะ',
      '{name} ไม่ต้องรับมือทุกอย่างคนเดียว ถ้าความรู้สึกหนักเกินกว่าจะไหว โปรดคุยกับอาจารย์ที่ปรึกษา นักจิตวิทยา หรือโทร 1323 ได้ทันที เรื่องของ {name} สำคัญเสมอ',
      'ช่วงนี้อาจรู้สึกหนักมาก ลองหยุดพักสิ่งที่ทำอยู่ ดื่มน้ำ หายใจช้า ๆ แล้วส่งข้อความหาคนที่ไว้ใจสักคน หากต้องการคนรับฟัง สายด่วน 1323 พร้อมรับฟัง {name} ตลอด 24 ชั่วโมง',
      'ผลการประเมินเป็นเพียงเครื่องมือคัดกรอง แต่ถ้า {name} รู้สึกว่าไม่ไหว นั่นคือสัญญาณที่ควรให้ความสำคัญ โปรดขอความช่วยเหลือจากผู้เชี่ยวชาญโดยเร็ว สายด่วน 1323 โทรฟรี'
    ]
  };

  const SENTIMENT_ADDONS = {
    negative: [
      'ข้อความที่เขียนระบายสะท้อนว่าช่วงนี้ใจหนักไม่น้อย ความรู้สึกเหล่านี้เกิดขึ้นได้กับทุกคน และการเล่าออกมาคือก้าวแรกที่ดีมาก',
      'ขอบคุณที่ไว้ใจเล่าความรู้สึกออกมานะ การได้ระบายช่วยให้ใจเบาลงได้จริง ๆ'
    ],
    positive: [
      'ในข้อความของคุณยังมีแสงของความหวังและพลังบวกอยู่ ลองเก็บความรู้สึกดี ๆ แบบนี้ไว้เป็นกำลังใจในวันที่เหนื่อยล้า',
      'น้ำเสียงในข้อความที่เขียนมีพลังบวกอยู่ไม่น้อย นั่นคือทรัพยากรสำคัญที่ช่วยให้รับมือกับความท้าทายได้ดี'
    ]
  };

  const SLEEP_ADDON =
    'เรื่องการนอน: ลองเข้านอนเร็วขึ้นอีกประมาณ 30 นาทีในคืนนี้ และวางโทรศัพท์ก่อนนอนสัก 30 นาที จะช่วยให้สมองฟื้นตัวได้ดีขึ้น';

  class ScheduleAdvisor {
    /**
     * ปรับตาราง Pomodoro ตามระดับความเครียด
     * ความเครียดสูง (High) → อ่าน 20 นาที / พัก 10 นาที พร้อมกิจกรรมผ่อนคลาย
     */
    static generateAdaptiveSchedule(stressScore) {
      const level = levelFromStress(stressScore);
      const profile = SCHEDULE_PROFILES[level];
      const rows = [];

      for (let i = 0; i < profile.rounds; i += 1) {
        rows.push({
          roundLabel: 'รอบ ' + (i + 1),
          type: 'study',
          activity: 'อ่านหนังสือ / ทำงาน',
          minutes: profile.study,
          tip: profile.studyTips[i % profile.studyTips.length]
        });

        if (i < profile.rounds - 1) {
          rows.push({
            roundLabel: 'รอบ ' + (i + 1),
            type: 'rest',
            activity: 'พักสั้น',
            minutes: profile.rest,
            tip: profile.restActivities[i % profile.restActivities.length]
          });
        }
      }

      rows.push({
        roundLabel: 'พักยาว',
        type: 'long-rest',
        activity: 'พักยาว',
        minutes: profile.longBreak,
        tip: profile.longBreakTip
      });

      const totalMinutes = rows.reduce((sum, r) => sum + r.minutes, 0);
      const summary =
        profile.label + ': อ่าน ' + profile.study + ' นาที / พัก ' + profile.rest + ' นาที × ' +
        profile.rounds + ' รอบ (รวมประมาณ ' + totalMinutes + ' นาที)' +
        (profile.note ? ' — ' + profile.note : '');

      return {
        level: level,
        label: profile.label,
        studyMinutes: profile.study,
        restMinutes: profile.rest,
        rounds: profile.rounds,
        longBreakMinutes: profile.longBreak,
        totalMinutes: totalMinutes,
        summary: summary,
        rows: rows
      };
    }

    /** สุ่มคำแนะนำฮีลใจเชิงบวก ปรับตามระดับความเครียด อารมณ์จากข้อความ และการนอน */
    static generateAdviceMessage(stressScore, sentimentScore, alias, context) {
      const ctx = context || {};
      const level = levelFromStress(stressScore);
      const name = alias && alias.charAt(0) !== '[' ? alias : 'เพื่อน';

      const parts = [pick(ADVICE_POOLS[level]).replace(/\{name\}/g, name)];

      if (ctx.hasJournal) {
        if (sentimentScore <= -0.25) parts.push(pick(SENTIMENT_ADDONS.negative));
        else if (sentimentScore >= 0.25) parts.push(pick(SENTIMENT_ADDONS.positive));
      }

      if (Number(ctx.sleepHours) < 6) parts.push(SLEEP_ADDON);

      if (ctx.crisisKeyword && level !== 'Critical') {
        parts.push('หากมีความคิดอยากทำร้ายตัวเองหรืออยากหายไป โปรดติดต่อสายด่วนสุขภาพจิต 1323 (โทรฟรี 24 ชั่วโมง) หรือบอกคนที่ไว้ใจทันที');
      }

      return parts.join('\n\n');
    }
  }


  /* ========================================================================
     MODULE 4 — CHART.JS VISUALIZER & LOCALSTORAGE MANAGEMENT
     ======================================================================== */

  /** จัดการประวัติการประเมินใน localStorage (สูงสุด 7 ครั้ง) */
  class HistoryStore {
    constructor(key, max) {
      this.key = key;
      this.max = max;
      this.cache = [];
      this.load();
    }

    static isValidEntry(e) {
      return !!e && typeof e === 'object' &&
        Number.isFinite(e.stressIndex) &&
        Number.isFinite(e.psychometricScore) &&
        typeof e.timestamp === 'string';
    }

    load() {
      try {
        const raw = window.localStorage.getItem(this.key);
        const parsed = raw ? JSON.parse(raw) : [];
        this.cache = Array.isArray(parsed)
          ? parsed.filter(HistoryStore.isValidEntry).slice(-this.max)
          : [];
      } catch (err) {
        console.warn('[UniMind Pro] ไม่สามารถอ่าน localStorage ได้:', err);
        this.cache = [];
      }
      return this.getAll();
    }

    getAll() {
      return this.cache.slice();
    }

    add(entry) {
      this.cache.push(entry);
      if (this.cache.length > this.max) {
        this.cache = this.cache.slice(-this.max);
      }
      this.persist();
      return this.getAll();
    }

    persist() {
      try {
        window.localStorage.setItem(this.key, JSON.stringify(this.cache));
        return true;
      } catch (err) {
        console.warn('[UniMind Pro] ไม่สามารถบันทึก localStorage ได้:', err);
        return false;
      }
    }
  }

  /** วาด/อัปเดต Radar Chart และ Trend Chart */
  class ChartManager {
    constructor(radarId, trendId) {
      this.radarId = radarId;
      this.trendId = trendId;
      this.radar = null;
      this.trend = null;
    }

    static get available() {
      return typeof window.Chart !== 'undefined';
    }

    init() {
      if (!ChartManager.available) {
        console.warn('[UniMind Pro] ไม่พบ Chart.js — กราฟจะไม่แสดงผล');
        return false;
      }
      window.Chart.defaults.font.family = "'Prompt', 'Kanit', sans-serif";
      window.Chart.defaults.color = '#475569';
      return true;
    }

    /** Radar Chart 5 มิติ จากคะแนนข้อ Q1–Q5 (0–3) */
    renderRadar(answers) {
      if (!ChartManager.available) return;
      const canvas = $(this.radarId);
      if (!canvas) return;

      const values = (answers || [0, 0, 0, 0, 0]).slice(0, 5);

      if (!this.radar) {
        this.radar = new window.Chart(canvas, {
          type: 'radar',
          data: {
            labels: RADAR_LABELS.slice(),
            datasets: [{
              label: 'คะแนน ST-5 (0–3)',
              data: values,
              backgroundColor: 'rgba(13, 148, 136, 0.25)',
              borderColor: '#0D9488',
              borderWidth: 2,
              pointBackgroundColor: '#10B981',
              pointBorderColor: '#FFFFFF',
              pointRadius: 4,
              pointHoverRadius: 6
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: true,
            aspectRatio: 1.15,
            scales: {
              r: {
                min: 0,
                max: 3,
                ticks: { stepSize: 1, backdropColor: 'transparent' },
                grid: { color: 'rgba(13, 148, 136, 0.18)' },
                angleLines: { color: 'rgba(13, 148, 136, 0.18)' },
                pointLabels: { font: { size: 12 } }
              }
            },
            plugins: { legend: { display: false } }
          }
        });
      } else {
        this.radar.data.datasets[0].data = values;
        this.radar.update();
      }
    }

    buildTrendData(history) {
      const labels = history.map((h) => formatShortDate(h.timestamp));
      const stress = history.map((h) => h.stressIndex);
      const psychometric = history.map((h) => round((h.psychometricScore / 15) * 100, 1));
      const lastIndex = history.length - 1;

      const previous = history.slice(0, -1);
      const average = previous.length
        ? round(previous.reduce((s, h) => s + h.stressIndex, 0) / previous.length, 1)
        : null;
      const averageLine = average === null ? [] : history.map(() => average);

      return {
        labels: labels,
        datasets: [
          {
            label: 'Stress Index (%)',
            data: stress,
            borderColor: '#0D9488',
            backgroundColor: 'rgba(13, 148, 136, 0.15)',
            fill: true,
            tension: 0.35,
            borderWidth: 3,
            pointBackgroundColor: history.map((h) => RISK_COLOR[h.burnoutLevel] || '#0D9488'),
            pointBorderColor: '#FFFFFF',
            pointBorderWidth: 2,
            pointRadius: history.map((_, i) => (i === lastIndex ? 8 : 5)),
            pointHoverRadius: 9
          },
          {
            label: 'คะแนน ST-5 (% ของ 15)',
            data: psychometric,
            borderColor: '#0EA5E9',
            borderDash: [5, 4],
            borderWidth: 2,
            fill: false,
            tension: 0.35,
            pointRadius: 3
          },
          {
            label: 'ค่าเฉลี่ยย้อนหลัง (Stress)',
            data: averageLine,
            borderColor: '#94A3B8',
            borderDash: [2, 6],
            borderWidth: 2,
            fill: false,
            pointRadius: 0
          }
        ]
      };
    }

    /** Trend Line Chart: เปรียบเทียบสถิติปัจจุบันกับประวัติย้อนหลัง */
    renderTrend(history) {
      if (!ChartManager.available) return;
      const canvas = $(this.trendId);
      if (!canvas) return;

      const data = this.buildTrendData(history || []);

      if (!this.trend) {
        this.trend = new window.Chart(canvas, {
          type: 'line',
          data: data,
          options: {
            responsive: true,
            maintainAspectRatio: true,
            aspectRatio: 1.7,
            interaction: { mode: 'index', intersect: false },
            scales: {
              y: {
                min: 0,
                max: 100,
                ticks: { callback: (v) => v + '%' },
                grid: { color: 'rgba(15, 23, 42, 0.06)' }
              },
              x: { grid: { display: false } }
            },
            plugins: {
              legend: {
                position: 'bottom',
                labels: {
                  usePointStyle: true,
                  filter: (item, chartData) => {
                    const ds = chartData.datasets[item.datasetIndex];
                    return !!ds && Array.isArray(ds.data) && ds.data.length > 0;
                  }
                }
              }
            }
          }
        });
      } else {
        this.trend.data.labels = data.labels;
        this.trend.data.datasets = data.datasets;
        this.trend.update();
      }
    }
  }


  /* ========================================================================
     MODULE 5 — JSON EXPORTER & SIMULATION HANDLER
     ======================================================================== */

  class JSONExporter {
    /** ดาวน์โหลดรายงานสรุปผลเป็นไฟล์ .json */
    static exportJSONReport(report) {
      if (!report) return false;

      const now = new Date();
      const stamp =
        now.getFullYear() + pad2(now.getMonth() + 1) + pad2(now.getDate()) + '-' +
        pad2(now.getHours()) + pad2(now.getMinutes()) + pad2(now.getSeconds());

      const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.href = url;
      link.download = 'unimind-report-' + stamp + '.json';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    }
  }

  /** จัดการ Loading Overlay และข้อความสถานะระหว่างประมวลผล (~1.5 วินาที) */
  class SimulationHandler {
    constructor(overlayId, totalMs, stepCount) {
      this.overlayId = overlayId;
      this.stepMs = Math.round(totalMs / Math.max(1, stepCount));
    }

    get overlay() {
      return $(this.overlayId);
    }

    show() {
      const el = this.overlay;
      if (!el) return;
      el.classList.remove('hidden');
      el.setAttribute('aria-busy', 'true');
    }

    hide() {
      const el = this.overlay;
      if (!el) return;
      el.classList.add('hidden');
      el.setAttribute('aria-busy', 'false');
    }

    setStatus(message) {
      const el = this.overlay;
      if (!el) return;
      const text = el.querySelector('.loading-text');
      if (text) text.textContent = message;
    }

    /** แสดงข้อความสถานะ → ทำงานจริง → รอตามเวลาจำลอง */
    async step(message, work) {
      this.setStatus(message);
      const output = typeof work === 'function' ? work() : undefined;
      await delay(this.stepMs);
      return output;
    }
  }


  /* ========================================================================
     APPLICATION CONTROLLER
     ======================================================================== */

  class UniMindApp {
    constructor() {
      this.dom = {};
      this.history = new HistoryStore(CONFIG.STORAGE_KEY, CONFIG.MAX_HISTORY);
      this.charts = new ChartManager('radarChart', 'trendChart');
      this.simulation = new SimulationHandler('loadingOverlay', CONFIG.SIMULATION_TOTAL_MS, SIMULATION_STEP_COUNT);
      this.lastReport = null;
      this.isProcessing = false;
    }

    init() {
      this.cacheDom();
      this.charts.init();
      this.charts.renderRadar([0, 0, 0, 0, 0]);
      this.charts.renderTrend(this.history.getAll());
      if (this.dom.adviceText) this.dom.adviceText.style.whiteSpace = 'pre-line';
      if (this.dom.formError) this.dom.formError.style.whiteSpace = 'pre-line';
      this.bindEvents();
    }

    cacheDom() {
      const ids = [
        'assessmentForm', 'alias', 'mood', 'workload', 'sleepHours', 'journal', 'formError', 'submitBtn',
        'stressValue', 'stressBadge', 'burnoutValue', 'burnoutBadge', 'sentimentValue', 'sentimentBadge',
        'scheduleSummary', 'scheduleBody', 'adviceText', 'exportBtn', 'dashboardColumn'
      ];
      ids.forEach((id) => { this.dom[id] = $(id); });
    }

    bindEvents() {
      const d = this.dom;

      if (d.assessmentForm) {
        d.assessmentForm.addEventListener('submit', (e) => this.handleSubmit(e));

        // Fallback สำหรับเบราว์เซอร์ที่ไม่รองรับ :has() — เติมคลาส .selected ให้ตัวเลือก Likert
        d.assessmentForm.addEventListener('change', (e) => {
          const target = e.target;
          if (target && target.type === 'radio') {
            const group = d.assessmentForm.querySelectorAll('input[name="' + target.name + '"]');
            group.forEach((radio) => {
              const label = radio.closest('label');
              if (label) label.classList.toggle('selected', radio.checked);
            });
          }
        });
      }

      // ตรวจจับคำเสี่ยงขณะพิมพ์ เพื่อแจ้งสายด่วน 1323 ทันที
      if (d.journal) {
        d.journal.addEventListener('input', debounce(() => {
          const found = SafetyGuardrails.detectCrisisKeywords(d.journal.value, { showBanner: true });
          if (!found.detected) CrisisBanner.clear('keyword');
        }, CONFIG.DEBOUNCE_MS));
      }

      if (d.exportBtn) {
        d.exportBtn.addEventListener('click', () => this.exportJSONReport());
      }
    }

    /* ----- Form reading & validation ----- */

    readForm() {
      const form = this.dom.assessmentForm;
      const answers = [1, 2, 3, 4, 5].map((n) => {
        const checked = form.querySelector('input[name="q' + n + '"]:checked');
        return checked ? Number(checked.value) : null;
      });

      return {
        alias: this.dom.alias.value.trim(),
        mood: this.dom.mood.value,
        workload: this.dom.workload.value,
        sleep: this.dom.sleepHours.value,
        answers: answers,
        journal: this.dom.journal.value
      };
    }

    validate(raw) {
      const errors = [];
      let firstInvalid = null;
      const flag = (message, element) => {
        errors.push(message);
        if (!firstInvalid) firstInvalid = element;
      };

      if (!raw.alias) flag('กรุณากรอกนามแฝง', this.dom.alias);
      if (!raw.mood) flag('กรุณาเลือกอารมณ์วันนี้', this.dom.mood);

      const workload = raw.workload === '' ? NaN : Number(raw.workload);
      if (!Number.isInteger(workload) || workload < 0 || workload > 50) {
        flag('กรุณากรอกจำนวนงานค้าง/สอบเป็นจำนวนเต็ม 0–50', this.dom.workload);
      }

      const sleep = raw.sleep === '' ? NaN : Number(raw.sleep);
      if (!Number.isFinite(sleep) || sleep < 0 || sleep > 24) {
        flag('กรุณากรอกชั่วโมงการนอน (0–24)', this.dom.sleepHours);
      }

      const missing = [];
      raw.answers.forEach((value, i) => { if (value === null) missing.push(i + 1); });
      if (missing.length > 0) {
        const firstRadio = this.dom.assessmentForm.querySelector('input[name="q' + missing[0] + '"]');
        flag('กรุณาตอบแบบประเมิน ST-5 ให้ครบ (ข้อที่ ' + missing.join(', ') + ')', firstRadio);
      }

      return {
        errors: errors,
        firstInvalid: firstInvalid,
        data: {
          alias: raw.alias,
          mood: Number(raw.mood),
          workload: workload,
          sleep: sleep,
          answers: raw.answers,
          journal: raw.journal
        }
      };
    }

    showError(message) {
      const el = this.dom.formError;
      if (!el) return;
      el.textContent = message;
      el.hidden = false;
    }

    hideError() {
      const el = this.dom.formError;
      if (!el) return;
      el.textContent = '';
      el.hidden = true;
    }

    /* ----- Submit flow ----- */

    async handleSubmit(event) {
      event.preventDefault();
      if (this.isProcessing) return;

      const check = this.validate(this.readForm());
      if (check.errors.length > 0) {
        this.showError(check.errors.join('\n'));
        if (check.firstInvalid && typeof check.firstInvalid.focus === 'function') {
          check.firstInvalid.focus({ preventScroll: true });
          check.firstInvalid.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        return;
      }

      this.hideError();
      this.isProcessing = true;
      if (this.dom.submitBtn) this.dom.submitBtn.disabled = true;
      this.simulation.show();

      try {
        const report = await this.runPipeline(check.data);
        this.lastReport = report;
        this.renderDashboard(report);
        this.revealResults(report);
      } catch (err) {
        console.error('[UniMind Pro] Processing error:', err);
        this.showError('เกิดข้อผิดพลาดในการประมวลผล กรุณาลองใหม่อีกครั้ง');
      } finally {
        this.simulation.hide();
        if (this.dom.submitBtn) this.dom.submitBtn.disabled = false;
        this.isProcessing = false;
      }
    }

    /** ไปป์ไลน์ 4 ขั้นตอน (รวมเวลาจำลอง ~1.5 วินาที) */
    async runPipeline(data) {
      const sim = this.simulation;
      const ctx = {};

      // 1) Anonymize + Safety check
      await sim.step('Anonymizing Data...', () => {
        const aliasResult = SafetyGuardrails.anonymizeWithStats(data.alias);
        const journalResult = SafetyGuardrails.anonymizeWithStats(data.journal);

        ctx.alias = aliasResult.text || 'ไม่ระบุนาม';
        ctx.journal = journalResult.text;
        ctx.redactions = aliasResult.redactions + journalResult.redactions;
        ctx.hasJournal = ctx.journal.length > 0;

        ctx.crisis = SafetyGuardrails.detectCrisisKeywords(ctx.journal, { showBanner: true });
        if (ctx.crisis.detected) {
          sim.setStatus('Safety Check: พบสัญญาณที่ควรได้รับการดูแล — สายด่วนสุขภาพจิต ' + CONFIG.HOTLINE);
        } else {
          CrisisBanner.clear('keyword');
        }
      });

      // 2) Psychometrics
      await sim.step('Calculating Psychometrics...', () => {
        ctx.psychometricScore = StressEngine.calculatePsychometricScore(data.answers);
      });

      // 3) Sentiment + Stress Index + Burnout
      await sim.step('Analyzing Sentiment & Stress Index...', () => {
        ctx.sentiment = StressEngine.calculateSentiment(ctx.journal);
        ctx.stress = StressEngine.calculateStressIndex({
          psychometricScore: ctx.psychometricScore,
          workloadCount: data.workload,
          sleepHours: data.sleep,
          sentimentScore: ctx.sentiment.score
        });
        ctx.burnout = StressEngine.classifyBurnoutRisk(ctx.stress.index, {
          sleepHours: data.sleep,
          workloadRatio: ctx.stress.workloadRatio,
          crisisKeyword: ctx.crisis.detected
        });

        if (ctx.stress.index > CONFIG.CRISIS_STRESS_THRESHOLD) {
          CrisisBanner.show('stress');
        } else {
          CrisisBanner.clear('stress');
        }
      });

      // 4) Schedule + Advice
      await sim.step('Generating Adaptive Schedule & AI Advice...', () => {
        ctx.schedule = ScheduleAdvisor.generateAdaptiveSchedule(ctx.stress.index);
        ctx.advice = ScheduleAdvisor.generateAdviceMessage(ctx.stress.index, ctx.sentiment.score, ctx.alias, {
          sleepHours: data.sleep,
          hasJournal: ctx.hasJournal,
          crisisKeyword: ctx.crisis.detected
        });
      });

      // บันทึกประวัติ (ไม่เก็บข้อความระบายความรู้สึก)
      const entry = {
        id: Date.now(),
        timestamp: new Date().toISOString(),
        alias: ctx.alias,
        mood: data.mood,
        workload: data.workload,
        sleepHours: data.sleep,
        answers: data.answers.slice(),
        psychometricScore: ctx.psychometricScore,
        sentimentScore: ctx.sentiment.score,
        stressIndex: ctx.stress.index,
        burnoutLevel: ctx.burnout.level
      };
      const historyEntries = this.history.add(entry);

      return this.buildReport(data, ctx, historyEntries);
    }

    buildReport(data, ctx, historyEntries) {
      const stressLevel = levelFromStress(ctx.stress.index);

      return {
        reportVersion: '1.0',
        application: 'UniMind Pro',
        generatedAt: new Date().toISOString(),
        profile: {
          alias: ctx.alias,
          moodScore: data.mood,
          pendingWorkloadCount: data.workload,
          sleepHours: data.sleep
        },
        psychometric: {
          instrument: 'ST-5',
          scale: '0=ไม่เลย, 1=บางครั้ง, 2=บ่อยครั้ง, 3=ตลอดเวลา',
          answers: data.answers.map((value, i) => ({
            question: 'Q' + (i + 1),
            dimension: RADAR_LABELS[i],
            value: value
          })),
          score: ctx.psychometricScore,
          maxScore: 15
        },
        sentiment: {
          score: ctx.sentiment.score,
          range: [-1.0, 1.0],
          journalProvided: ctx.hasJournal,
          piiRedactions: ctx.redactions
        },
        stress: {
          index: ctx.stress.index,
          unit: 'percent',
          level: stressLevel,
          formula: '(Psychometric*3.5) + (Workload_Ratio*20) + (Sleep_Deficit*15) - (Sentiment*10)',
          workloadRatio: ctx.stress.workloadRatio,
          sleepDeficit: ctx.stress.sleepDeficit,
          components: ctx.stress.components
        },
        burnout: {
          level: ctx.burnout.level,
          escalatedByContext: ctx.burnout.escalated
        },
        crisis: {
          flagged: ctx.crisis.detected || ctx.stress.index > CONFIG.CRISIS_STRESS_THRESHOLD,
          keywordDetected: ctx.crisis.detected,
          highStress: ctx.stress.index > CONFIG.CRISIS_STRESS_THRESHOLD,
          hotline: CONFIG.HOTLINE
        },
        schedule: ctx.schedule,
        advice: ctx.advice,
        history: historyEntries.map((h) => ({
          timestamp: h.timestamp,
          stressIndex: h.stressIndex,
          psychometricScore: h.psychometricScore,
          sentimentScore: h.sentimentScore,
          burnoutLevel: h.burnoutLevel
        })),
        privacyNote: 'รายงานนี้ไม่รวมข้อความระบายความรู้สึกต้นฉบับ และข้อมูลส่วนบุคคลถูกปกปิดก่อนประมวลผล',
        disclaimer: 'ผลนี้เป็นเครื่องมือคัดกรองเบื้องต้น ไม่ใช่การวินิจฉัยทางการแพทย์ หากต้องการความช่วยเหลือ โทรสายด่วนสุขภาพจิต 1323'
      };
    }

    /* ----- Rendering ----- */

    renderDashboard(report) {
      const d = this.dom;
      const stressIndex = report.stress.index;

      // Metric 1: Stress Index
      if (d.stressValue) d.stressValue.textContent = Math.round(stressIndex) + '%';
      const stressLevel = report.stress.level;
      setBadge(d.stressBadge, RISK_KEY[stressLevel], 'ระดับ' + RISK_TH[stressLevel]);

      // Metric 2: Burnout Risk
      const burnoutLevel = report.burnout.level;
      if (d.burnoutValue) d.burnoutValue.textContent = burnoutLevel;
      setBadge(d.burnoutBadge, RISK_KEY[burnoutLevel], 'ความเสี่ยง' + RISK_TH[burnoutLevel]);

      // Metric 3: Sentiment
      const sentiment = report.sentiment.score;
      if (d.sentimentValue) d.sentimentValue.textContent = formatSentiment(sentiment);
      const sentimentView = this.describeSentiment(sentiment, report.sentiment.journalProvided);
      setBadge(d.sentimentBadge, sentimentView.key, sentimentView.text);

      // Schedule
      this.renderSchedule(report.schedule);

      // Advice
      if (d.adviceText) d.adviceText.textContent = report.advice;

      // Charts
      this.charts.renderRadar(report.psychometric.answers.map((a) => a.value));
      this.charts.renderTrend(this.history.getAll());

      // Export
      if (d.exportBtn) d.exportBtn.disabled = false;
    }

    describeSentiment(score, hasText) {
      if (!hasText) return { key: 'med', text: 'ไม่ได้ระบุข้อความ' };
      if (score >= 0.25) return { key: 'low', text: 'เชิงบวก' };
      if (score > -0.25) return { key: 'med', text: 'เป็นกลาง' };
      if (score > -0.6) return { key: 'high', text: 'เชิงลบ' };
      return { key: 'critical', text: 'เชิงลบมาก' };
    }

    renderSchedule(schedule) {
      const d = this.dom;
      if (d.scheduleSummary) d.scheduleSummary.textContent = schedule.summary;
      if (!d.scheduleBody) return;

      d.scheduleBody.textContent = '';

      const iconByType = { study: 'fa-book-open', rest: 'fa-mug-hot', 'long-rest': 'fa-bed' };

      schedule.rows.forEach((row) => {
        const tr = document.createElement('tr');
        if (row.type !== 'study') tr.style.background = 'rgba(16, 185, 129, 0.07)';

        const cells = [
          { text: row.roundLabel },
          { text: row.activity, icon: iconByType[row.type] },
          { text: row.minutes + ' นาที' },
          { text: row.tip }
        ];

        cells.forEach((cell) => {
          const td = document.createElement('td');
          td.style.padding = '10px';
          td.style.borderBottom = '1px solid rgba(13, 148, 136, 0.15)';
          td.style.verticalAlign = 'top';

          if (cell.icon) {
            const icon = document.createElement('i');
            icon.className = 'fa-solid ' + cell.icon;
            icon.style.marginRight = '8px';
            icon.style.color = '#0D9488';
            td.appendChild(icon);
          }
          td.appendChild(document.createTextNode(cell.text));
          tr.appendChild(td);
        });

        d.scheduleBody.appendChild(tr);
      });
    }

    /** เลื่อนหน้าจอไปยังผลลัพธ์ (โดยเฉพาะบนมือถือที่เป็น 1 คอลัมน์) */
    revealResults(report) {
      const banner = $('crisisAlert');
      if (report.crisis.flagged && banner && !banner.hidden) {
        banner.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      const isSingleColumn = window.matchMedia && window.matchMedia('(max-width: 768px)').matches;
      if (isSingleColumn && this.dom.dashboardColumn) {
        this.dom.dashboardColumn.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }

    exportJSONReport() {
      if (!this.lastReport) {
        this.showError('ยังไม่มีผลการประเมินให้ส่งออก กรุณากดประมวลผลก่อน');
        return false;
      }
      return JSONExporter.exportJSONReport(this.lastReport);
    }
  }


  /* ========================================================================
     BOOTSTRAP
     ======================================================================== */

  let app = null;

  function exportJSONReport() {
    return app ? app.exportJSONReport() : false;
  }

  function bootstrap() {
    app = new UniMindApp();
    app.init();

    // เปิดเผยออบเจ็กต์สำหรับดีบัก/ทดสอบผ่าน Console
    window.UniMindPro = {
      app: app,
      SafetyGuardrails: SafetyGuardrails,
      StressEngine: StressEngine,
      ScheduleAdvisor: ScheduleAdvisor,
      ChartManager: ChartManager,
      HistoryStore: HistoryStore,
      JSONExporter: JSONExporter,
      SimulationHandler: SimulationHandler,
      anonymizeInput: SafetyGuardrails.anonymizeInput,
      detectCrisisKeywords: SafetyGuardrails.detectCrisisKeywords,
      generateAdaptiveSchedule: ScheduleAdvisor.generateAdaptiveSchedule,
      generateAdviceMessage: ScheduleAdvisor.generateAdviceMessage,
      exportJSONReport: exportJSONReport
    };
    window.exportJSONReport = exportJSONReport;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
