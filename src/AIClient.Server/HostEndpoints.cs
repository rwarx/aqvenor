using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using AIClient.Application.Configuration;
using AIClient.Application.Interfaces;

namespace AIClient.Server;

/// <summary>Permission changes issued by the Electron main process after an explicit native choice.</summary>
public static class HostEndpoints
{
    public static void Map(WebApplication app)
    {
        // Captured once at startup. The renderer's bearer never grants this additional capability.
        var configured = app.Configuration["HostToken"];
        var tokenHash = string.IsNullOrEmpty(configured) ? null : SHA256.HashData(Encoding.UTF8.GetBytes(configured));
        var gate = new SemaphoreSlim(1, 1);
        app.MapPost("/api/host/agent-permissions", async (HttpContext context, ISettingsService settings, JsonElement body) =>
        {
            var supplied = context.Request.Headers["X-Aqvenor-Host-Token"];
            if (tokenHash is null || supplied.Count != 1 || string.IsNullOrEmpty(supplied[0]) ||
                supplied[0]!.Length > 512 || !CryptographicOperations.FixedTimeEquals(tokenHash,
                    SHA256.HashData(Encoding.UTF8.GetBytes(supplied[0]!))))
            {
                return Results.Json(new { error = "A trusted desktop host is required." }, statusCode: StatusCodes.Status403Forbidden);
            }

            if (body.ValueKind != JsonValueKind.Object)
            {
                return Results.BadRequest(new { error = "The permission body must be an object." });
            }
            bool? commands = null;
            bool? shells = null;
            var fields = new HashSet<string>(StringComparer.Ordinal);
            foreach (var field in body.EnumerateObject())
            {
                if (!fields.Add(field.Name) || field.Name is not ("allowCommands" or "allowShellCommands") ||
                    field.Value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                {
                    return Results.BadRequest(new { error = "Only distinct boolean allowCommands and allowShellCommands fields are accepted." });
                }
                if (field.Name == "allowCommands")
                {
                    commands = field.Value.GetBoolean();
                }
                else
                {
                    shells = field.Value.GetBoolean();
                }
            }
            if (fields.Count == 0)
            {
                return Results.BadRequest(new { error = "Choose an execution permission to change." });
            }

            await gate.WaitAsync(context.RequestAborted).ConfigureAwait(false);
            try
            {
                var nextCommands = commands ?? settings.Current.Agent.AllowCommands;
                var nextShells = shells ?? settings.Current.Agent.AllowShellCommands;
                if (!nextCommands && shells == true)
                {
                    return Results.BadRequest(new { error = "Shell scripts require running programs to be enabled." });
                }
                nextShells &= nextCommands;
                await settings.UpdateAsync<AgentSettings>(agent =>
                {
                    agent.AllowCommands = nextCommands;
                    agent.AllowShellCommands = nextShells;
                }, context.RequestAborted).ConfigureAwait(false);
                return Results.Ok(new { allowCommands = nextCommands, allowShellCommands = nextShells });
            }
            finally
            {
                gate.Release();
            }
        }).RequireAuthorization();
    }
}
