// Shared by full transcript reads and metadata-only history indexes.
// BranchNavigator still traverses recursively, so keep the response tree shallow.
const MAX_PROJECTED_TREE_DEPTH = 200;
const MAX_BRANCH_PREVIEW_LENGTH = 40;

export function branchPreviewForEntry(entry: { id?: string; type?: string; message?: unknown }): { role?: "user" | "assistant"; text: string } | undefined {
  if (entry.type !== "message" || !entry.message || typeof entry.message !== "object" || Array.isArray(entry.message)) return undefined;
  const message = entry.message as { role?: unknown; content?: unknown };
  let text = typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content.filter((block): block is { type?: unknown; text?: unknown } => typeof block === "object" && block !== null).filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text as string).join(" ")
      : "";
  text = text.replace(/\s+/g, " " ).trim();
  if (text.length > MAX_BRANCH_PREVIEW_LENGTH) text = `${text.slice(0, MAX_BRANCH_PREVIEW_LENGTH)}…`;
  if (!text) text = message.role === "assistant" ? "[assistant]" : "message";
  const role = message.role === "user" || message.role === "assistant" ? message.role : undefined;
  return { ...(role ? { role } : {}), text };
}

/**
 * Project the session tree into the shallow navigation tree sent to the client.
 * Keeps roots, labeled entries, branch points, and leaves while contracting chains
 * without recursive traversal. Contracted entry IDs are attached to the next
 * visible node so the UI can still recognize an active leaf inside the chain.
 */
export function projectTreeForResponse<T extends { entry: { id: string }; children: T[]; compressedEntryIds?: string[]; label?: string }>(
  nodes: T[]
): T[] {
  const keep = new Set<T>();
  const roots = new Set(nodes);
  const seen = new Set<T>();
  const stack = [...nodes];

  while (stack.length > 0) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);

    if (
      roots.has(node) ||
      Boolean(node.label) ||
      node.children.length !== 1
    ) {
      keep.add(node);
    }

    for (const child of node.children) {
      stack.push(child);
    }
  }

  const cloneNode = (node: T, compressedEntryIds?: string[], branchPreview?: { role?: "user" | "assistant"; text: string }): T => ({
    ...node,
    children: [],
    ...(compressedEntryIds?.length ? { compressedEntryIds } : {}),
    ...(branchPreview ? { branchPreview } : {}),
  });
  const projectedRoots = nodes.map((node) => cloneNode(node, undefined, branchPreviewForEntry(node.entry)));
  const tasks = nodes.map((source, index) => ({
    source,
    projected: projectedRoots[index],
    depth: 1,
  }));

  const appendFlattenedKeptDescendants = (source: T, projectedParent: T) => {
    const pending = [{ node: source, compressedEntryIds: [] as string[], branchPreview: undefined as { role?: "user" | "assistant"; text: string } | undefined }];
    const flattenedSeen = new Set<T>();

    while (pending.length > 0) {
      const { node, compressedEntryIds, branchPreview } = pending.pop()!;
      if (flattenedSeen.has(node)) continue;
      flattenedSeen.add(node);

      if (keep.has(node)) {
        projectedParent.children.push(cloneNode(node, compressedEntryIds, branchPreview ?? branchPreviewForEntry(node.entry)));
      }

      for (let i = node.children.length - 1; i >= 0; i--) {
        pending.push({
          node: node.children[i],
          compressedEntryIds: keep.has(node)
            ? []
            : [...compressedEntryIds, node.entry.id],
          branchPreview: keep.has(node) ? undefined : (branchPreview ?? branchPreviewForEntry(node.entry)),
        });
      }
    }
  };

  while (tasks.length > 0) {
    const { source, projected, depth } = tasks.pop()!;

    for (const sourceChild of source.children) {
      let child = sourceChild;

      if (depth >= MAX_PROJECTED_TREE_DEPTH) {
        appendFlattenedKeptDescendants(child, projected);
        continue;
      }

      const compressedEntryIds: string[] = [];
      let branchPreview = branchPreviewForEntry(child.entry);
      while (!keep.has(child) && child.children.length === 1) {
        compressedEntryIds.push(child.entry.id);
        child = child.children[0];
        branchPreview ??= branchPreviewForEntry(child.entry);
      }

      if (!keep.has(child)) {
        continue;
      }

      const projectedChild = cloneNode(child, compressedEntryIds, branchPreview);
      projected.children.push(projectedChild);
      tasks.push({ source: child, projected: projectedChild, depth: depth + 1 });
    }
  }

  return projectedRoots;
}
