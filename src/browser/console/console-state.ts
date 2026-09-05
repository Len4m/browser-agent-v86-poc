export interface SnapshotConsoleUiState {
  activeSessionId: string | null;
  serialTitle: string;
  sessions: Array<{
    sessionId: string;
    title: string;
  }>;
}
