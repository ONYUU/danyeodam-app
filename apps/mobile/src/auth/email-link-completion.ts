export type EmailLinkCompletionDependencies = {
  complete(url: string): Promise<void>;
  verifyActiveIdentity(): Promise<void>;
  rejectedFlowId(url: string): string | null;
  clearRejectedFlow(flowId: string): Promise<void>;
};

export async function completeEmailLinkWithActiveIdentity(
  url: string,
  dependencies: EmailLinkCompletionDependencies,
): Promise<void> {
  try {
    await dependencies.complete(url);
    await dependencies.verifyActiveIdentity();
  } catch (error) {
    const flowId = dependencies.rejectedFlowId(url);
    if (flowId !== null) {
      await dependencies.clearRejectedFlow(flowId).catch(() => undefined);
    }
    throw error;
  }
}
