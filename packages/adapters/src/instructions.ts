/** How an agent creates, reads, and changes one kind of artifact on a host. A text names no role. */
export type HostInstructions = { create: string; read: string; change: string };

/** The host instructions of a document host, and where a review of a page is filed on it. */
export type PageInstructions = HostInstructions & { report: string };
