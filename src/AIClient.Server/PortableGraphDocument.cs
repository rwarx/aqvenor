using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using AIClient.Domain.Graph;

namespace AIClient.Server;

public sealed record GraphViewport(double Zoom = 1, double PanX = 0, double PanY = 0)
{
    [JsonIgnore]
    public bool IsValid => double.IsFinite(Zoom) && Zoom > 0 && Zoom <= 100
        && double.IsFinite(PanX) && double.IsFinite(PanY);
}

/// <summary>The portable copy of the server graph, with presentation metadata outside the snapshot.</summary>
public sealed record PortableGraphDocument
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        Converters = { new JsonStringEnumConverter(allowIntegerValues: false) },
    };

    public int Version { get; init; } = 2;
    public required GraphSnapshot Snapshot { get; init; }
    public GraphViewport Viewport { get; init; } = new();

    // Retain UI and future metadata when an older server updates only the authoritative graph.
    [JsonExtensionData]
    public Dictionary<string, JsonElement> AdditionalData { get; init; } = [];

    public string Serialize() => JsonSerializer.Serialize(this, Json) + "\n";

    public static PortableGraphDocument Parse(string content)
    {
        var root = JsonNode.Parse(content) as JsonObject
            ?? throw new JsonException("The portable canvas must be a JSON object.");
        var version = root["version"]?.GetValue<int>() ?? 1;
        if (version is not (1 or 2)) { throw new JsonException($"Unsupported portable canvas version {version}."); }
        if (version == 1)
        {
            if (root["nodes"] is not JsonArray nodes || root["edges"] is not JsonArray edges)
            {
                throw new JsonException("The legacy canvas must contain nodes and edges.");
            }
            var nodeMetadata = new JsonObject();
            var edgeMetadata = new JsonObject();
            foreach (var item in nodes)
            {
                if (item is not JsonObject node) { throw new JsonException("Invalid canvas node."); }
                CaptureMetadata(node, nodeMetadata, ["id", "kind", "title", "meta", "note", "path", "x", "y", "w", "h", "status", "subtitle", "detail", "width", "height", "metric"]);
                Rename(node, "meta", "subtitle");
                Rename(node, "note", "detail");
                Rename(node, "w", "width");
                Rename(node, "h", "height");
            }
            foreach (var item in edges)
            {
                if (item is not JsonObject edge) { throw new JsonException("Invalid canvas edge."); }
                CaptureMetadata(edge, edgeMetadata, ["id", "from", "to", "kind", "note", "sourceId", "targetId", "label"]);
                Rename(edge, "from", "sourceId");
                Rename(edge, "to", "targetId");
                Rename(edge, "note", "label");
            }
            root["snapshot"] = new JsonObject
            {
                ["version"] = 0,
                ["nodes"] = nodes.DeepClone(),
                ["edges"] = edges.DeepClone(),
            };
            root.Remove("nodes");
            root.Remove("edges");
            if (nodeMetadata.Count > 0) { root["legacyNodeMetadata"] = nodeMetadata; }
            if (edgeMetadata.Count > 0) { root["legacyEdgeMetadata"] = edgeMetadata; }
            root["version"] = 2;
        }

        var document = root.Deserialize<PortableGraphDocument>(Json)
            ?? throw new JsonException("The portable canvas is empty.");
        if (document.Snapshot is null || document.Snapshot.Nodes is null || document.Snapshot.Edges is null
            || document.Snapshot.Nodes.Count > 20_000 || document.Snapshot.Edges.Count > 100_000)
        {
            throw new JsonException("The portable canvas has invalid or excessive graph content.");
        }
        if (document.Snapshot.Nodes.Any(n => n is null) || document.Snapshot.Edges.Any(e => e is null))
        {
            throw new JsonException("The portable canvas contains null graph entries.");
        }
        if (document.Viewport is null || !document.Viewport.IsValid)
        {
            throw new JsonException("The portable canvas viewport is invalid.");
        }
        if (document.Snapshot.Version < 0) { throw new JsonException("The snapshot version is invalid."); }

        // Restore does not validate relationships; use the same mutator that judges every API edit.
        var model = new GraphModel();
        var result = model.Apply(new GraphChangeSet
        {
            Title = "Portable canvas validation",
            Origin = GraphChangeOrigin.User,
            Changes = [.. document.Snapshot.Nodes.Select(n => (GraphChange)new AddNode(n)),
                .. document.Snapshot.Edges.Select(e => (GraphChange)new AddEdge(e))],
        });
        if (result.Rejected.Count > 0)
        {
            throw new JsonException("Invalid portable canvas: " + result.Rejected[0]);
        }
        return document;
    }

    private static void Rename(JsonObject value, string from, string to)
    {
        if (!value.TryGetPropertyValue(from, out var old)) { return; }
        if (!value.ContainsKey(to)) { value[to] = old?.DeepClone(); }
        value.Remove(from);
    }

    private static void CaptureMetadata(JsonObject value, JsonObject metadata, string[] known)
    {
        var extra = new JsonObject();
        foreach (var pair in value)
        {
            if (!known.Contains(pair.Key, StringComparer.Ordinal)) { extra[pair.Key] = pair.Value?.DeepClone(); }
        }
        if (extra.Count > 0 && value["id"] is JsonValue id) { metadata[id.GetValue<string>()] = extra; }
    }
}
