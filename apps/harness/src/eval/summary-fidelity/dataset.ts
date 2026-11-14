/**
 * 交接保真度評估的資料集（[#2774](https://github.com/DemianLi/nexus-agent/issues/2774)）：腳本化的長對話，裡面埋已知事實，
 * 摘要之後問同一組題目，看事實有沒有活過摘要。
 *
 * 每個變體是一到兩段對話。每一段都長過評估用的摘要門檻，而且**事實全在前半、結尾是一長串不含事實的雜訊**：摘要器逐字留下的
 * 只有尾巴，事實只能靠摘要帶過去。跑者把落在尾巴裡的題目標成 `leaked`、不計分
 * （{@link ./runner.ts}），`summary-fidelity.test.ts` 釘住沒有題目落在尾巴、雜訊裡也沒有題目的字串。
 *
 * 題目的 `mentions` 是答案裡必須出現的字串（比對不看空白），交給 `../scorers.ts` 的 `scoreMentions` 計分；所以事實盡量挑寫法固定的
 * （編號、路徑、不帶千分位的數字），題目也要求照寫。`stale` 是被推翻的舊結論，答案裡出現就記一筆過時命中，不進分數。
 */

import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';

/** 一題。 */
export interface FidelityQuestion {
  readonly id: string;
  /** 問模型的那句話。 */
  readonly prompt: string;
  /** 答案裡必須出現的字串（比對不看空白）。 */
  readonly mentions: readonly string[];
  /** 被推翻的舊結論；答案裡出現任何一個就是過時命中。 */
  readonly stale?: readonly string[];
  /** 這題的事實在第幾段（從 0 起算）。段數減去它，就是這個事實經過幾次摘要。 */
  readonly segment: number;
  /** 事實的種類，逐題報表印成一欄。 */
  readonly kind: 'path' | 'value' | 'correction' | 'todo' | 'overturned';
}

/** 一個變體。 */
export interface FidelityVariant {
  readonly id: 'single' | 'double' | 'zh' | 'overturned';
  readonly title: string;
  /** 一段一次摘要；每一段以使用者的話結尾。 */
  readonly segments: readonly (readonly BaseMessage[])[];
  readonly questions: readonly FidelityQuestion[];
}

let callSeq = 0;

/** 一次工具呼叫與它的結果。 */
function toolRound(name: string, args: Record<string, unknown>, result: string): BaseMessage[] {
  const id = `call_${(callSeq += 1)}`;
  return [
    new AIMessage({ content: '', tool_calls: [{ id, name, args }] }),
    new ToolMessage({ content: result, tool_call_id: id, name }),
  ];
}

/** 不含任何事實的英文雜訊：一份存取日誌，逐行不同。 */
function accessLog(seed: number, lines: number): string {
  const paths = ['/healthz', '/api/v2/items', '/static/app.css', '/api/v2/session', '/favicon.ico'];
  return Array.from({ length: lines }, (_, index) => {
    const n = seed * 1000 + index;
    return `10.0.${n % 250}.${(n * 7) % 250} - - [worker-${n % 9}] "GET ${paths[n % paths.length]} HTTP/1.1" ${n % 11 === 0 ? 304 : 200} ${10_000 + ((n * 37) % 9_000)}`;
  }).join('\n');
}

/** 不含任何事實的中文雜訊：一份會議室借用紀錄，逐行不同。 */
function roomLog(seed: number, lines: number): string {
  const rooms = ['甲會議室', '乙會議室', '簡報室', '研討室', '視訊室'];
  const units = ['總務科', '資訊科', '會計室', '人事室', '秘書室'];
  return Array.from({ length: lines }, (_, index) => {
    const n = seed * 1000 + index;
    return `第 ${n} 筆：${units[n % units.length]}借用${rooms[(n * 3) % rooms.length]}，時段 ${8 + (n % 9)} 時至 ${9 + (n % 9)} 時，出席 ${3 + (n % 14)} 人，設備正常。`;
  }).join('\n');
}

/**
 * 每串雜訊結尾有幾輪不帶工具結果的純文字。摘要器逐字留下的尾巴落在這幾輪裡，所以問題目的那次請求不含工具訊息，
 * 不必為了它綁工具。
 */
const PLAIN_TAIL_ROUNDS = 3;

/** 一長串英文雜訊輪：`rounds` 次讀日誌、幾輪純文字，最後以使用者的話收尾。 */
function englishFiller(seed: number, rounds: number): BaseMessage[] {
  const messages: BaseMessage[] = [];
  for (let round = 0; round < rounds; round += 1) {
    messages.push(
      new HumanMessage(
        `Unrelated: show me access log chunk ${seed}-${round}, I am checking traffic.`,
      ),
      ...toolRound(
        'read_file',
        { path: `/var/log/gateway/chunk-${seed}-${round}.log` },
        accessLog(seed + round, 70),
      ),
      new AIMessage(
        `Chunk ${seed}-${round} looks routine: only 200 and 304 responses, nothing to act on.`,
      ),
    );
  }
  for (let round = 0; round < PLAIN_TAIL_ROUNDS; round += 1) {
    messages.push(
      new HumanMessage(`Paste the summary table for window ${seed}-${round} here in the chat.`),
      new AIMessage(
        `Summary table for window ${seed}-${round}:\n${accessLog(seed + 50 + round, 40)}`,
      ),
    );
  }
  messages.push(new HumanMessage('Thanks, the traffic looks normal. Let us carry on.'));
  return messages;
}

/** 一長串中文雜訊輪，形狀同 {@link englishFiller}。 */
function chineseFiller(seed: number, rounds: number): BaseMessage[] {
  const messages: BaseMessage[] = [];
  for (let round = 0; round < rounds; round += 1) {
    messages.push(
      new HumanMessage(`另外一件事：請列出會議室借用紀錄第 ${seed}-${round} 批，我要看使用率。`),
      ...toolRound(
        'read_file',
        { path: `/data/總務/會議室借用/第${seed}-${round}批.txt` },
        roomLog(seed + round, 45),
      ),
      new AIMessage(`第 ${seed}-${round} 批都是例行借用，設備正常，沒有需要處理的事項。`),
    );
  }
  for (let round = 0; round < PLAIN_TAIL_ROUNDS; round += 1) {
    messages.push(
      new HumanMessage(`請把第 ${seed}-${round} 個時段的彙整表直接貼在對話裡。`),
      new AIMessage(`第 ${seed}-${round} 個時段的彙整表：\n${roomLog(seed + 50 + round, 30)}`),
    );
  }
  messages.push(new HumanMessage('好，使用率看起來正常。我們繼續。'));
  return messages;
}

const SINGLE_FACTS: BaseMessage[] = [
  new HumanMessage(
    'I am preparing the vendor review. The spreadsheet we work from is /srv/finance/reports/q3/vendor-review-v7.xlsx, please keep using that exact file.',
  ),
  new AIMessage('Understood. I will work from /srv/finance/reports/q3/vendor-review-v7.xlsx.'),
  new HumanMessage('The spending cap for this review is 48750 euros. Flag anything above it.'),
  new AIMessage('Noted: the cap is 48750 euros.'),
  new HumanMessage('The review is due on March 12.'),
  new AIMessage('Got it, due March 12.'),
  new HumanMessage(
    'Correction: I misread the calendar. The review is due on March 19, not March 12.',
  ),
  new AIMessage('Updated: the review is due on March 19.'),
  ...toolRound(
    'read_file',
    { path: '/srv/finance/reports/q3/vendor-review-v7.xlsx' },
    'sheet "vendors": 14 rows. Largest line item: Halvorsen Logistics, 39120 euros. Tracking ticket: INC-20417.',
  ),
  new AIMessage(
    'The largest line item is Halvorsen Logistics at 39120 euros, under the cap. The tracking ticket is INC-20417.',
  ),
  new HumanMessage(
    'One thing still open: we have not yet sent the shortlist to Priya Raman in procurement. Remind me later, do not send it yourself.',
  ),
  new AIMessage('I will not send it. Open item: send the shortlist to Priya Raman in procurement.'),
];

const SINGLE_QUESTIONS: FidelityQuestion[] = [
  {
    id: 'path',
    prompt: 'Which spreadsheet file are we working from? Write its full path exactly.',
    mentions: ['/srv/finance/reports/q3/vendor-review-v7.xlsx'],
    segment: 0,
    kind: 'path',
  },
  {
    id: 'cap',
    prompt: 'What is the spending cap for this review? Write the number exactly, digits only.',
    mentions: ['48750'],
    segment: 0,
    kind: 'value',
  },
  {
    id: 'ticket',
    prompt: 'What is the tracking ticket id? Write it exactly.',
    mentions: ['INC-20417'],
    segment: 0,
    kind: 'value',
  },
  {
    id: 'due',
    prompt: 'On which date is the review due? Answer with the date only.',
    mentions: ['March 19'],
    stale: ['March 12'],
    segment: 0,
    kind: 'correction',
  },
  {
    id: 'todo',
    prompt: 'Is there anything we still have to do that is not done yet? Name the person involved.',
    mentions: ['Priya'],
    segment: 0,
    kind: 'todo',
  },
];

const DOUBLE_LATER_FACTS: BaseMessage[] = [
  new HumanMessage(
    'New topic. The deployment runbook lives at /opt/platform/runbooks/failover-eu-west.md, use that one from now on.',
  ),
  new AIMessage('Understood, the runbook is /opt/platform/runbooks/failover-eu-west.md.'),
  new HumanMessage('The failover drill must finish within 1350 seconds.'),
  new AIMessage('Noted: the drill limit is 1350 seconds.'),
  new HumanMessage('Run the drill against the staging-b cluster.'),
  new AIMessage('I will target staging-b.'),
  new HumanMessage(
    'Correction: staging-b is being rebuilt. Run the drill against staging-d instead.',
  ),
  new AIMessage('Updated: the drill targets staging-d.'),
  new HumanMessage(
    'Still open on this topic: nobody has booked the change window with Tomasz Wrona yet. Keep that on the list.',
  ),
  new AIMessage('Open item: book the change window with Tomasz Wrona.'),
];

const DOUBLE_LATER_QUESTIONS: FidelityQuestion[] = [
  {
    id: 'runbook',
    prompt: 'Where is the deployment runbook? Write its full path exactly.',
    mentions: ['/opt/platform/runbooks/failover-eu-west.md'],
    segment: 1,
    kind: 'path',
  },
  {
    id: 'drill-limit',
    prompt: 'Within how many seconds must the failover drill finish? Digits only.',
    mentions: ['1350'],
    segment: 1,
    kind: 'value',
  },
  {
    id: 'drill-target',
    prompt: 'Which cluster should the drill run against? Answer with the cluster name only.',
    mentions: ['staging-d'],
    stale: ['staging-b'],
    segment: 1,
    kind: 'correction',
  },
  {
    id: 'window',
    prompt: 'Who do we still need to book the change window with?',
    mentions: ['Tomasz'],
    segment: 1,
    kind: 'todo',
  },
];

const ZH_FACTS: BaseMessage[] = [
  new HumanMessage(
    '我在準備採購案的簽呈。草稿放在 /data/公文/113年度/採購案-0042.odt，之後都改這一份。',
  ),
  new AIMessage('了解，之後都以 /data/公文/113年度/採購案-0042.odt 為準。'),
  new HumanMessage('這個案子的預算上限是新臺幣 865000 元，超過的品項要標出來。'),
  new AIMessage('記下了，預算上限是新臺幣 865000 元。'),
  new HumanMessage('開標日期訂在 4 月 9 日。'),
  new AIMessage('好的，開標日期是 4 月 9 日。'),
  new HumanMessage('更正一下，我看錯行事曆了：開標日期是 4 月 23 日，不是 4 月 9 日。'),
  new AIMessage('已更正：開標日期是 4 月 23 日。'),
  ...toolRound(
    'read_file',
    { path: '/data/公文/113年度/採購案-0042.odt' },
    '簽呈草稿：品項共 9 項，最高單價品項為機房不斷電系統。收文字號：府資採字第 1130078 號。',
  ),
  new AIMessage('草稿共 9 項，最高單價是機房不斷電系統。收文字號是府資採字第 1130078 號。'),
  new HumanMessage('還有一件事沒做：還沒請會計室的林淑芬會簽。先記著，不要自己送。'),
  new AIMessage('我不會自己送。待辦：請會計室的林淑芬會簽。'),
];

const ZH_QUESTIONS: FidelityQuestion[] = [
  {
    id: 'path',
    prompt: '簽呈草稿放在哪裡？請原樣寫出完整路徑。',
    mentions: ['/data/公文/113年度/採購案-0042.odt'],
    segment: 0,
    kind: 'path',
  },
  {
    id: 'budget',
    prompt: '這個案子的預算上限是多少？請只用阿拉伯數字寫出金額，不要加逗號。',
    mentions: ['865000'],
    segment: 0,
    kind: 'value',
  },
  {
    id: 'doc-number',
    prompt: '收文字號是幾號？請原樣寫出。',
    mentions: ['1130078'],
    segment: 0,
    kind: 'value',
  },
  {
    id: 'bid-date',
    prompt: '開標日期是哪一天？請只回答日期，寫成「幾月幾日」。',
    mentions: ['4 月 23 日'],
    stale: ['4 月 9 日'],
    segment: 0,
    kind: 'correction',
  },
  {
    id: 'todo',
    prompt: '還有什麼事還沒做？請寫出相關的人名。',
    mentions: ['林淑芬'],
    segment: 0,
    kind: 'todo',
  },
];

const OVERTURNED_FACTS: BaseMessage[] = [
  new HumanMessage(
    'We need to pick the database for the case-tracking service. Let us go with MySQL.',
  ),
  new AIMessage('Decision recorded: the case-tracking service will use MySQL.'),
  new HumanMessage('And host it in the Frankfurt region.'),
  new AIMessage('Decision recorded: host in the Frankfurt region.'),
  new HumanMessage('The weekly sync with the vendor is on Tuesdays.'),
  new AIMessage('Noted: weekly vendor sync on Tuesdays.'),
  new HumanMessage('Authentication will go through the existing LDAP directory.'),
  new AIMessage('Noted: authentication through the existing LDAP directory.'),
  ...englishFiller(900, 2).slice(0, -1 - 2 * PLAIN_TAIL_ROUNDS),
  new HumanMessage(
    'I spoke with the data team. We are reversing the database decision: use PostgreSQL instead, MySQL is off the table because of the JSON indexing requirement.',
  ),
  new AIMessage('Decision reversed: the case-tracking service will use PostgreSQL, not MySQL.'),
  new HumanMessage(
    'Legal also came back: the data must stay in the Netherlands, so host in the Amsterdam region, not Frankfurt.',
  ),
  new AIMessage('Decision reversed: host in the Amsterdam region, not Frankfurt.'),
  new HumanMessage(
    'And the vendor moved the weekly sync to Thursdays, Tuesdays no longer work for them.',
  ),
  new AIMessage('Updated: weekly vendor sync on Thursdays.'),
];

const OVERTURNED_QUESTIONS: FidelityQuestion[] = [
  {
    id: 'database',
    prompt:
      'Which database will the case-tracking service use? Answer with the database name only.',
    mentions: ['PostgreSQL'],
    stale: ['MySQL'],
    segment: 0,
    kind: 'overturned',
  },
  {
    id: 'region',
    prompt: 'In which region will it be hosted? Answer with the city name only.',
    mentions: ['Amsterdam'],
    stale: ['Frankfurt'],
    segment: 0,
    kind: 'overturned',
  },
  {
    id: 'sync-day',
    prompt: 'On which weekday is the weekly vendor sync? Answer with the weekday only.',
    mentions: ['Thursday'],
    stale: ['Tuesday'],
    segment: 0,
    kind: 'overturned',
  },
  {
    id: 'auth',
    prompt: 'How will authentication work? Name the directory technology.',
    mentions: ['LDAP'],
    segment: 0,
    kind: 'value',
  },
];

/** 四個變體。雜訊的種子各不相同，內容不重複。 */
export const FIDELITY_VARIANTS: readonly FidelityVariant[] = [
  {
    id: 'single',
    title: '摘要一次',
    segments: [[...SINGLE_FACTS, ...englishFiller(100, 8)]],
    questions: SINGLE_QUESTIONS,
  },
  {
    id: 'double',
    title: '連續摘要兩次',
    segments: [
      [...SINGLE_FACTS, ...englishFiller(200, 8)],
      [...DOUBLE_LATER_FACTS, ...englishFiller(300, 8)],
    ],
    questions: [...SINGLE_QUESTIONS, ...DOUBLE_LATER_QUESTIONS],
  },
  {
    id: 'zh',
    title: '中文對話',
    segments: [[...ZH_FACTS, ...chineseFiller(400, 8)]],
    questions: ZH_QUESTIONS,
  },
  {
    id: 'overturned',
    title: '決定被推翻',
    segments: [[...OVERTURNED_FACTS, ...englishFiller(500, 8)]],
    questions: OVERTURNED_QUESTIONS,
  },
];
