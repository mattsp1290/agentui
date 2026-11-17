/**
 * Counts what the host does to a provider extension through the public contract alone: activation, connection,
 * snapshots, command lookups, feed subscriptions per conversation and cleanup. It forwards every call unchanged and wraps both
 * registration modes (`add` and `addAgui`).
 */
export function instrument(extension) {
  const counts = { activations: 0, disposes: 0, connects: 0, closes: 0, snapshots: 0, lookups: 0, feeds: 0, maxFeedsPerConversation: 0, observes: [] };
  const open = new Map();
  const { entry } = extension.value;
  const wrapBackend = backend => ({ ...backend,
    async snapshot(binding) { counts.snapshots++; return backend.snapshot(binding); },
    async reconcileCommand(operation) { counts.lookups++; return backend.reconcileCommand(operation); },
    observe(request, receive) {
      const key = request.binding.creation.operationId;
      counts.observes.push({ key, after: request.after });
      const feed = backend.observe(request, receive);
      counts.feeds++;
      open.set(key, (open.get(key) ?? 0) + 1);
      counts.maxFeedsPerConversation = Math.max(counts.maxFeedsPerConversation, open.get(key));
      const settle = () => { counts.feeds--; open.set(key, open.get(key) - 1); };
      feed.ended.then(settle, settle);
      return feed;
    },
    async close() { counts.closes++; return backend.close(); },
  });
  const wrapProvider = provider => ({ ...provider, async connect(request) {
    counts.connects++;
    const result = await provider.connect(request);
    return result.kind === 'connected' ? { ...result, backend: wrapBackend(result.backend) } : result;
  } });
  const activate = async context => {
    counts.activations++;
    const { add, addAgui } = context.providers;
    const lifetime = await entry.activate({ ...context, providers: { ...context.providers,
      add: (id, provider, ...rest) => add(id, wrapProvider(provider), ...rest),
      addAgui: (id, provider, ...rest) => addAgui(id, wrapProvider(provider), ...rest) } });
    return { async dispose() { counts.disposes++; return lifetime.dispose(); } };
  };
  return { counts, value: { ...extension.value, entry: { ...entry, activate } } };
}
