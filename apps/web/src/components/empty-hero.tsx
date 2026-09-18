import { AgentOrb } from '@/components/agent-orb';

/**
 * 空白狀態（inventory 列 7）：還沒有任何一則、也沒有待決的時候，取代「還沒有訊息」。
 * 原型那排建議按鈕沒搬：那是假資料，nexus 沒有可以建議的東西。
 */
export function EmptyHero() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 py-10 text-center">
      <AgentOrb state="breathing" size={64} label="待命" />
      <h2 className="text-2xl font-semibold tracking-tight">今天要做什麼？</h2>
    </div>
  );
}
