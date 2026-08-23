import { Rocket } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';

export function App() {
  const [runs, setRuns] = useState(0);

  return (
    <main className="mx-auto flex min-h-svh max-w-2xl flex-col justify-center gap-6 px-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">nexus-agent</h1>
        <p className="text-muted-foreground text-sm">harness 與 web UI 的骨架已就緒。</p>
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={() => setRuns((count) => count + 1)}>
          <Rocket />
          執行 harness
        </Button>
        <span className="text-muted-foreground text-sm" role="status">
          已執行 {runs} 次
        </span>
      </div>
    </main>
  );
}
