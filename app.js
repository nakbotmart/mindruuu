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
      '{name} ไม่ต้องรับมือทุกอย่างคนเดียว ถ้าความรู้สึกหนักเกินกว่าจะไหว โปรดคุยกับอาจารย์ที่ปรึกษา นักจิตวิทยา
