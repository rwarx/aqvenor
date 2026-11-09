using System.Net;
using System.Net.Http.Json;
using AIClient.Application.Configuration;
using AIClient.Application.DTOs;
using AIClient.Application.Interfaces;
using AIClient.Domain.Enums;
using AIClient.Infrastructure;
using AIClient.Infrastructure.Configuration;
using AIClient.Server;
using AIClient.Tests.Support;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace AIClient.Tests;

public sealed class ChildConversationMutationTests : IAsyncLifetime
{
    private TestDatabase _db = null!;
    private CancellationToken Token => TestContext.Current.CancellationToken;
    public async ValueTask InitializeAsync() => _db = await TestDatabase.CreateAsync(Token);
    public async ValueTask DisposeAsync() => await _db.DisposeAsync();

    [Theory]
    [InlineData("conversation-delete")]
    [InlineData("message-delete")]
    [InlineData("message-edit")]
    [InlineData("truncate-after")]
    public async Task A_reserved_child_transcript_cannot_be_mutated_until_its_cleanup_finishes(string operation)
    {
        await using var host = await CreateApiAsync();
        var child = await NewConversationAsync(host.Conversations);
        var parentRun = Guid.NewGuid();
        var parent = Assert.IsType<RunEntry>(host.Runs.Start(parentRun, Guid.NewGuid()));
        using var reservation = Assert.IsAssignableFrom<IDisposable>(host.Runs.TryReserveChild(parentRun, child.ConversationId));

        using var refused = await MutateAsync(host.Client, operation, child);
        Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);
        Assert.Contains("subagent", await refused.Content.ReadAsStringAsync(Token), StringComparison.OrdinalIgnoreCase);
        await AssertIntactAsync(host.Conversations, child);

        // Stop signals cancellation; until the child releases its lease its transcript is still owned.
        parent.Cancel();
        using var stopping = await MutateAsync(host.Client, operation, child);
        Assert.Equal(HttpStatusCode.Conflict, stopping.StatusCode);
        await AssertIntactAsync(host.Conversations, child);

        reservation.Dispose();
        using var accepted = await MutateAsync(host.Client, operation, child);
        Assert.Equal(HttpStatusCode.OK, accepted.StatusCode);
        var result = await host.Conversations.GetAsync(child.ConversationId, Token);
        if (operation == "conversation-delete")
        {
            Assert.Null(result);
        }
        else
        {
            Assert.NotNull(result);
            if (operation == "message-edit")
            {
                Assert.Equal("Edited", result.Messages[0].Content);
            }
            else
            {
                Assert.Single(result.Messages);
            }
        }
        host.Runs.Finish(parentRun);
    }

    [Theory]
    [InlineData("conversation-delete")]
    [InlineData("message-delete")]
    [InlineData("message-edit")]
    [InlineData("truncate-after")]
    public async Task A_reserved_child_does_not_block_changes_to_an_unrelated_conversation(string operation)
    {
        await using var host = await CreateApiAsync();
        var child = await NewConversationAsync(host.Conversations);
        var unrelated = await NewConversationAsync(host.Conversations);
        var parentRun = Guid.NewGuid();
        Assert.NotNull(host.Runs.Start(parentRun, Guid.NewGuid()));
        using var reservation = Assert.IsAssignableFrom<IDisposable>(host.Runs.TryReserveChild(parentRun, child.ConversationId));
        using var response = await MutateAsync(host.Client, operation, unrelated);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        await AssertIntactAsync(host.Conversations, child);
        host.Runs.Finish(parentRun);
    }

    [Fact]
    public async Task Deleting_a_project_unfiles_a_reserved_child_and_keeps_its_transcript()
    {
        await using var host = await CreateApiAsync();
        var child = await NewConversationAsync(host.Conversations);
        var project = await host.Conversations.CreateProjectAsync(new NewProject { Name = "Delegated work" }, Token);
        await host.Conversations.SetProjectAsync(child.ConversationId, project.Id, Token);
        var parentRun = Guid.NewGuid();
        Assert.NotNull(host.Runs.Start(parentRun, Guid.NewGuid()));
        using var reservation = Assert.IsAssignableFrom<IDisposable>(host.Runs.TryReserveChild(parentRun, child.ConversationId));
        using var response = await host.Client.DeleteAsync($"/api/projects/{project.Id}", Token);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var result = await host.Conversations.GetAsync(child.ConversationId, Token);
        Assert.NotNull(result);
        Assert.Null(result.ProjectId);
        await AssertIntactAsync(host.Conversations, child);
        await host.Conversations.AddMessageAsync(child.ConversationId, new NewMessage { Role = MessageRole.Assistant, Content = "Continued" }, Token);
        Assert.Equal(3, (await host.Conversations.GetAsync(child.ConversationId, Token))!.Messages.Count);
        host.Runs.Finish(parentRun);
    }

    private async Task<ConversationFixture> NewConversationAsync(IConversationService conversations)
    {
        var chat = await conversations.CreateAsync("Child", cancellationToken: Token);
        var anchor = await conversations.AddMessageAsync(chat.Id, new NewMessage { Role = MessageRole.User, Content = "Original request" }, Token);
        await conversations.AddMessageAsync(chat.Id, new NewMessage { Role = MessageRole.Assistant, Content = "Original answer" }, Token);
        return new(chat.Id, anchor.Id);
    }

    private async Task AssertIntactAsync(IConversationService conversations, ConversationFixture child)
    {
        var result = await conversations.GetAsync(child.ConversationId, Token);
        Assert.NotNull(result);
        Assert.Equal(new[] { "Original request", "Original answer" }, result.Messages.Select(message => message.Content));
    }

    private Task<HttpResponseMessage> MutateAsync(HttpClient client, string operation, ConversationFixture child) => operation switch
    {
        "conversation-delete" => client.DeleteAsync($"/api/conversations/{child.ConversationId}", Token),
        "message-delete" => client.DeleteAsync($"/api/messages/{child.MessageId}", Token),
        "message-edit" => client.PatchAsJsonAsync($"/api/messages/{child.MessageId}", new { content = "Edited" }, Token),
        "truncate-after" => client.PostAsync($"/api/messages/{child.MessageId}/truncate-after", null, Token),
        _ => throw new ArgumentException("Unknown transcript mutation.", nameof(operation)),
    };

    private async Task<ApiHost> CreateApiAsync()
    {
        var settings = _db.Settings();
        await settings.LoadAsync(Token);
        var conversations = _db.Conversations();
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Services.AddInfrastructure(builder.Configuration);
        builder.Services.AddSingleton<IAppPaths>(new AppPaths(Path.GetDirectoryName(_db.DatabasePath)!));
        builder.Services.AddSingleton<ISettingsService>(settings);
        builder.Services.AddSingleton<IConversationService>(conversations);
        var runs = new RunRegistry();
        builder.Services.AddSingleton(runs);
        builder.Services.AddSingleton<GraphPersistence>();
        builder.Services.AddSingleton<GraphWriteRegistry>();
        builder.Services.AddSingleton<JsonCheckpointStore>();
        builder.Services.AddSingleton(new SidecarToken("child-mutation-tests"));
        builder.Services.AddAuthentication(SidecarTokenHandler.SchemeName)
            .AddScheme<AuthenticationSchemeOptions, SidecarTokenHandler>(SidecarTokenHandler.SchemeName, _ => { });
        SidecarAuthorization.Configure(builder.Services);
        var app = builder.Build();
        app.UseAuthentication();
        app.UseAuthorization();
        DataEndpoints.Map(app);
        await app.StartAsync(Token);
        var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
        var client = new HttpClient { BaseAddress = new Uri(address) };
        client.DefaultRequestHeaders.Authorization = new("Bearer", "child-mutation-tests");
        return new(app, client, runs, conversations);
    }

    private sealed record ConversationFixture(Guid ConversationId, Guid MessageId);
    private sealed record ApiHost(WebApplication App, HttpClient Client, RunRegistry Runs, IConversationService Conversations) : IAsyncDisposable
    {
        public async ValueTask DisposeAsync() { Client.Dispose(); await App.DisposeAsync(); }
    }
}
