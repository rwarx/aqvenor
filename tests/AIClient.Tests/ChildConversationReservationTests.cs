using System.Net;
using System.Net.Http.Json;
using AIClient.Infrastructure;
using AIClient.Server;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace AIClient.Tests;

public sealed class ChildConversationReservationTests
{
    [Fact]
    public void A_child_conversation_rejects_another_live_run_until_its_owner_releases_it()
    {
        var registry = new RunRegistry();
        var parentRun = Guid.NewGuid();
        Assert.NotNull(registry.Start(parentRun, Guid.NewGuid()));
        var child = Guid.NewGuid();
        using var reservation = Reserve(registry, parentRun, child);
        Assert.Null(registry.Start(Guid.NewGuid(), child));
        reservation.Dispose();
        var standalone = Guid.NewGuid();
        Assert.NotNull(registry.Start(standalone, child));
        registry.Finish(standalone);
        registry.Finish(parentRun);
    }

    [Fact]
    public void A_run_created_without_a_conversation_cannot_bind_to_a_reserved_child()
    {
        var registry = new RunRegistry();
        var parentRun = Guid.NewGuid();
        var standaloneRun = Guid.NewGuid();
        var child = Guid.NewGuid();
        Assert.NotNull(registry.Start(parentRun, Guid.NewGuid()));
        using var reservation = Reserve(registry, parentRun, child);
        Assert.NotNull(registry.Start(standaloneRun));
        Assert.Throws<InvalidOperationException>(() => registry.BindConversation(standaloneRun, child));
        reservation.Dispose();
        registry.BindConversation(standaloneRun, child);
        registry.Finish(standaloneRun);
        registry.Finish(parentRun);
    }

    [Fact]
    public void Existing_runs_and_other_parents_keep_ownership_of_their_conversations()
    {
        var registry = new RunRegistry();
        var firstParent = Guid.NewGuid();
        var secondParent = Guid.NewGuid();
        var firstChat = Guid.NewGuid();
        var child = Guid.NewGuid();
        Assert.NotNull(registry.Start(firstParent, firstChat));
        Assert.NotNull(registry.Start(secondParent, Guid.NewGuid()));
        Assert.Null(registry.TryReserveChild(firstParent, firstChat));
        Assert.Null(registry.TryReserveChild(secondParent, firstChat));
        Assert.Null(registry.TryReserveChild(Guid.NewGuid(), child));
        using var reservation = Reserve(registry, firstParent, child);
        Assert.Null(registry.TryReserveChild(firstParent, child));
        Assert.Null(registry.TryReserveChild(secondParent, child));
        registry.Finish(firstParent);
        registry.Finish(secondParent);
    }

    [Fact]
    public void Stop_keeps_the_child_reserved_until_cleanup_and_refuses_new_children()
    {
        var registry = new RunRegistry();
        var parentRun = Guid.NewGuid();
        var parent = Assert.IsType<RunEntry>(registry.Start(parentRun, Guid.NewGuid()));
        var child = Guid.NewGuid();
        using var reservation = Reserve(registry, parentRun, child);
        parent.Cancel();
        Assert.Null(registry.Start(Guid.NewGuid(), child));
        Assert.Null(registry.TryReserveChild(parentRun, Guid.NewGuid()));
        reservation.Dispose();
        var standalone = Guid.NewGuid();
        Assert.NotNull(registry.Start(standalone, child));
        registry.Finish(standalone);
        registry.Finish(parentRun);
    }

    [Fact]
    public void Finishing_a_parent_releases_all_children_and_old_leases_cannot_release_new_owners()
    {
        var registry = new RunRegistry();
        var parentRun = Guid.NewGuid();
        var firstChild = Guid.NewGuid();
        var secondChild = Guid.NewGuid();
        Assert.NotNull(registry.Start(parentRun, Guid.NewGuid()));
        using var oldLease = Reserve(registry, parentRun, firstChild);
        using var secondLease = Reserve(registry, parentRun, secondChild);
        registry.Finish(parentRun);
        var standalone = Guid.NewGuid();
        Assert.NotNull(registry.Start(standalone, secondChild));
        registry.Finish(standalone);

        // Reusing both ids is allowed after completion; the old lease belongs to the old execution.
        Assert.NotNull(registry.Start(parentRun, Guid.NewGuid()));
        using var replacement = Reserve(registry, parentRun, firstChild);
        oldLease.Dispose();
        oldLease.Dispose();
        Assert.Null(registry.Start(Guid.NewGuid(), firstChild));
        replacement.Dispose();
        var resumed = Guid.NewGuid();
        Assert.NotNull(registry.Start(resumed, firstChild));
        registry.Finish(resumed);
        registry.Finish(parentRun);
    }

    [Fact]
    public void A_standalone_run_and_child_reservation_cannot_win_the_same_conversation_race()
    {
        var registry = new RunRegistry();
        var parentRun = Guid.NewGuid();
        Assert.NotNull(registry.Start(parentRun, Guid.NewGuid()));
        for (var attempt = 0; attempt < 30; attempt++)
        {
            var child = Guid.NewGuid();
            var standalone = Guid.NewGuid();
            RunEntry? entry = null;
            IDisposable? reservation = null;
            Parallel.Invoke(
                () => entry = registry.Start(standalone, child),
                () => reservation = registry.TryReserveChild(parentRun, child));
            Assert.NotEqual(entry is null, reservation is null);
            reservation?.Dispose();
            registry.Finish(standalone);
        }
        registry.Finish(parentRun);
    }

    [Fact]
    public void The_http_guard_requires_a_live_parent_and_keeps_its_approval_entry()
    {
        var previous = HttpAgentApproval.CurrentRunId.Value;
        var registry = new RunRegistry();
        var guard = new HttpChildConversationGuard(registry);
        var parentRun = Guid.NewGuid();
        var parent = Assert.IsType<RunEntry>(registry.Start(parentRun, Guid.NewGuid()));
        var child = Guid.NewGuid();
        try
        {
            HttpAgentApproval.CurrentRunId.Value = null;
            Assert.Null(guard.TryReserve(child));
            HttpAgentApproval.CurrentRunId.Value = Guid.NewGuid();
            Assert.Null(guard.TryReserve(child));
            HttpAgentApproval.CurrentRunId.Value = parentRun;
            using var reservation = Assert.IsAssignableFrom<IDisposable>(guard.TryReserve(child));
            Assert.True(registry.TryGet(parentRun, out var owner));
            Assert.Same(parent, owner);
            Assert.False(registry.TryGet(child, out _));
            Assert.Null(registry.Start(Guid.NewGuid(), child));
        }
        finally
        {
            HttpAgentApproval.CurrentRunId.Value = previous;
            registry.Finish(parentRun);
        }
    }

    [Theory]
    [InlineData("/api/agent/run")]
    [InlineData("/api/chat/send")]
    public async Task Http_runs_for_a_reserved_child_are_rejected_without_starting_another_generation(string route)
    {
        await using var host = await CreateApiAsync();
        var parentRun = Guid.NewGuid();
        var child = Guid.NewGuid();
        Assert.NotNull(host.Runs.Start(parentRun, Guid.NewGuid()));
        using var reservation = Reserve(host.Runs, parentRun, child);
        using var response = await host.Client.PostAsJsonAsync(route, new
        {
            runId = Guid.NewGuid(), conversationId = child, content = "Continue this chat.",
            providerId = "unavailable-provider", modelId = "unavailable-model", mode = "Build",
        });
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Contains("already in flight", await response.Content.ReadAsStringAsync(), StringComparison.Ordinal);
        reservation.Dispose();
        var standalone = Guid.NewGuid();
        Assert.NotNull(host.Runs.Start(standalone, child));
        host.Runs.Finish(standalone);
        host.Runs.Finish(parentRun);
    }

    private static IDisposable Reserve(RunRegistry registry, Guid parentRun, Guid child) =>
        Assert.IsAssignableFrom<IDisposable>(registry.TryReserveChild(parentRun, child));

    private static async Task<ApiHost> CreateApiAsync()
    {
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Services.AddInfrastructure(builder.Configuration);
        var runs = new RunRegistry();
        builder.Services.AddSingleton(runs);
        builder.Services.AddSingleton<GraphPersistence>();
        builder.Services.AddSingleton(new SidecarToken("child-conversation-tests"));
        builder.Services.AddAuthentication(SidecarTokenHandler.SchemeName)
            .AddScheme<AuthenticationSchemeOptions, SidecarTokenHandler>(SidecarTokenHandler.SchemeName, _ => { });
        SidecarAuthorization.Configure(builder.Services);
        var app = builder.Build();
        app.UseAuthentication();
        app.UseAuthorization();
        RunEndpoints.Map(app);
        await app.StartAsync();
        var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
        var client = new HttpClient { BaseAddress = new Uri(address) };
        client.DefaultRequestHeaders.Authorization = new("Bearer", "child-conversation-tests");
        return new ApiHost(app, client, runs);
    }

    private sealed record ApiHost(WebApplication App, HttpClient Client, RunRegistry Runs) : IAsyncDisposable
    {
        public async ValueTask DisposeAsync() { Client.Dispose(); await App.DisposeAsync(); }
    }
}
