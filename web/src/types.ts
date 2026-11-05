export type Rule = { id: string; name: string; method: string; path: string; kind: string; limit: number; delayMs: number; status: number; enabled: boolean };
export type Scenario = { version: number; name: string; description: string; rules: Rule[] };
export type TrafficEvent = { id: number; startedAt: string; method: string; path: string; status: number; upstreamStatus: number; durationMs: number; fault: string; rule: string; outcome: string; runId: string };
export type Run = { id: string; startedAt: string; mode: string; scenario: string; scenarioSnapshot?: Scenario; fixture?: string; attempts: { number: number; status: number; outcome: string }[]; storedWorkouts: number; passed: boolean; durationMs: number };
export type State = { target: string; proxyUrl: string; demoAvailable: boolean; scenario: Scenario; counts: Record<string, number>; events: TrafficEvent[]; lastRun: Run | null };
