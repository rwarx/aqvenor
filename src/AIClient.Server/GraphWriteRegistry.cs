using AIClient.Application.Interfaces;
using AIClient.Domain.Graph;

namespace AIClient.Server;

/// <summary>Retrying a lost HTTP response must not apply the same graph mutation twice.</summary>
public sealed class GraphWriteRegistry
{
    private readonly object _gate = new();
    private readonly Dictionary<Guid, (string Fingerprint, Task<GraphMutationResult> Result)> _requests = [];

    public Task<GraphMutationResult> ApplyAsync(Guid? id, string fingerprint, GraphChangeSet changes, IGraphService graph, CancellationToken ct)
    {
        if (id is null) { return graph.ApplyAsync(changes, ct); }
        lock (_gate)
        {
            if (_requests.TryGetValue(id.Value, out var existing))
            {
                if (existing.Fingerprint != fingerprint) { throw new InvalidOperationException("The graph request id was reused with different changes."); }
                if (!existing.Result.IsFaulted && !existing.Result.IsCanceled) { return existing.Result.WaitAsync(ct); }
                _requests.Remove(id.Value);
            }
            if (_requests.Count >= 256)
            {
                var oldest = _requests.FirstOrDefault(pair => pair.Value.Result.IsCompleted);
                if (oldest.Value.Result is null) { throw new InvalidOperationException("Too many graph requests are pending."); }
                _requests.Remove(oldest.Key);
            }
            var result = graph.ApplyAsync(changes, ct);
            _requests[id.Value] = (fingerprint, result);
            return result;
        }
    }
}
