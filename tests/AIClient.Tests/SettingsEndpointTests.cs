using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using AIClient.Application.Configuration;
using AIClient.Application.Interfaces;
using AIClient.Infrastructure;
using AIClient.Infrastructure.Configuration;
using AIClient.Infrastructure.Graph;
using AIClient.Server;
using AIClient.Tests.Support;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace AIClient.Tests;

public sealed class SettingsEndpointTests : IAsyncLifetime
{
    private TestDatabase _db = null!;
    private CancellationToken Token => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync() => _db = await TestDatabase.CreateAsync(Token);
    public async ValueTask DisposeAsync() => await _db.DisposeAsync();

    [Theory]
    [InlineData("Light", "German", ThemeMode.Light, UiLanguage.German)]
    [InlineData("Dark", "Russian", ThemeMode.Dark, UiLanguage.Russian)]
    [InlineData("System", "English", ThemeMode.System, UiLanguage.English)]
    public async Task Named_theme_and_language_survive_a_restart(
        string theme, string language, ThemeMode expectedTheme, UiLanguage expectedLanguage)
    {
        await using var host = await CreateApiAsync();
        using var appearance = await host.Client.PutAsJsonAsync("/api/settings/appearance", new { theme }, Token);
        using var general = await host.Client.PutAsJsonAsync("/api/settings/general", new { language }, Token);
        Assert.Equal(HttpStatusCode.OK, appearance.StatusCode);
        Assert.Equal(HttpStatusCode.OK, general.StatusCode);

        using var response = await host.Client.GetAsync("/api/settings", Token);
        response.EnsureSuccessStatusCode();
        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync(Token));
        Assert.Equal(theme, body.RootElement.GetProperty("appearance").GetProperty("theme").GetString());
        Assert.Equal(language, body.RootElement.GetProperty("general").GetProperty("language").GetString());

        var reloaded = _db.Settings();
        await reloaded.LoadAsync(Token);
        Assert.Equal(expectedTheme, reloaded.Current.Appearance.Theme);
        Assert.Equal(expectedLanguage, reloaded.Current.General.Language);
        Assert.True(reloaded.Current.General.ConfirmBeforeDelete);
    }

    [Theory]
    [InlineData(1, 2, ThemeMode.Light, UiLanguage.German)]
    [InlineData(2, 1, ThemeMode.Dark, UiLanguage.Russian)]
    [InlineData(0, 0, ThemeMode.System, UiLanguage.English)]
    public async Task Legacy_numeric_theme_and_language_remain_accepted(
        int theme, int language, ThemeMode expectedTheme, UiLanguage expectedLanguage)
    {
        await using var host = await CreateApiAsync();
        using var appearance = await host.Client.PutAsJsonAsync("/api/settings/appearance", new { theme }, Token);
        using var general = await host.Client.PutAsJsonAsync("/api/settings/general", new { language }, Token);
        Assert.Equal(HttpStatusCode.OK, appearance.StatusCode);
        Assert.Equal(HttpStatusCode.OK, general.StatusCode);

        var reloaded = _db.Settings();
        await reloaded.LoadAsync(Token);
        Assert.Equal(expectedTheme, reloaded.Current.Appearance.Theme);
        Assert.Equal(expectedLanguage, reloaded.Current.General.Language);
    }

    [Theory]
    [InlineData("appearance", "{\"theme\":\"UnknownTheme\",\"chatFontSize\":18}")]
    [InlineData("general", "{\"language\":\"UnknownLanguage\",\"confirmBeforeDelete\":false}")]
    public async Task Invalid_named_enum_is_rejected_without_changing_persisted_settings(string section, string json)
    {
        var settings = _db.Settings();
        await settings.LoadAsync(Token);
        await settings.UpdateAsync<AppearanceSettings>(s => s.Theme = ThemeMode.Light, Token);
        await settings.UpdateAsync<GeneralSettings>(s => s.Language = UiLanguage.German, Token);
        await using var host = await CreateApiAsync();
        using var content = new StringContent(json, Encoding.UTF8, "application/json");
        using var response = await host.Client.PutAsync($"/api/settings/{section}", content, Token);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);

        var reloaded = _db.Settings();
        await reloaded.LoadAsync(Token);
        Assert.Equal(ThemeMode.Light, reloaded.Current.Appearance.Theme);
        Assert.Equal(UiLanguage.German, reloaded.Current.General.Language);
        Assert.Equal(14, reloaded.Current.Appearance.ChatFontSize);
        Assert.True(reloaded.Current.General.ConfirmBeforeDelete);
    }

    [Fact]
    public async Task Storage_log_level_name_survives_a_restart()
    {
        await using var host = await CreateApiAsync();
        using var response = await host.Client.PutAsJsonAsync("/api/settings/storage", new { minimumLogLevel = "Debug" }, Token);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var reloaded = _db.Settings();
        await reloaded.LoadAsync(Token);
        Assert.Equal("Debug", reloaded.Current.Storage.MinimumLogLevel);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("wrong-host-token")]
    public async Task Renderer_bearer_cannot_change_execution_permissions(string? hostToken)
    {
        await using var host = await CreateApiAsync("trusted-host-secret");
        using var response = await HostPatch(host.Client, """{"allowCommands":true,"allowShellCommands":true}""", hostToken);
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        var reloaded = _db.Settings();
        await reloaded.LoadAsync(Token);
        Assert.False(reloaded.Current.Agent.AllowCommands);
        Assert.False(reloaded.Current.Agent.AllowShellCommands);
    }

    [Fact]
    public async Task A_host_without_a_configured_secret_cannot_change_permissions()
    {
        await using var host = await CreateApiAsync();
        using var response = await HostPatch(host.Client, """{"allowCommands":true}""", "some-token");
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task Trusted_host_permissions_persist_and_disabling_commands_also_disables_shells()
    {
        await using var host = await CreateApiAsync("trusted-host-secret");
        using var enable = await HostPatch(host.Client, """{"allowCommands":true,"allowShellCommands":true}""", "trusted-host-secret");
        Assert.Equal(HttpStatusCode.OK, enable.StatusCode);
        var reloaded = _db.Settings();
        await reloaded.LoadAsync(Token);
        Assert.True(reloaded.Current.Agent.AllowCommands);
        Assert.True(reloaded.Current.Agent.AllowShellCommands);
        using var disable = await HostPatch(host.Client, """{"allowCommands":false}""", "trusted-host-secret");
        Assert.Equal(HttpStatusCode.OK, disable.StatusCode);
        using var payload = JsonDocument.Parse(await disable.Content.ReadAsStringAsync(Token));
        Assert.False(payload.RootElement.GetProperty("allowCommands").GetBoolean());
        Assert.False(payload.RootElement.GetProperty("allowShellCommands").GetBoolean());
        await reloaded.LoadAsync(Token);
        Assert.False(reloaded.Current.Agent.AllowCommands);
        Assert.False(reloaded.Current.Agent.AllowShellCommands);
    }

    [Theory]
    [InlineData("""{"allowCommands":true,"workspaceRoot":"C:/"}""")]
    [InlineData("{\"allowCommands\":true,\"allowNetwork\":true}")]
    [InlineData("{\"allowCommands\":true,\"allowShellCommands\":\"true\"}")]
    [InlineData("{\"allowCommands\":true,\"allowCommands\":false}")]
    [InlineData("{\"allowCommands\":false,\"allowShellCommands\":true}")]
    [InlineData("{}")]
    [InlineData("[]")]
    public async Task Trusted_host_rejects_invalid_or_extra_fields_without_a_partial_change(string json)
    {
        await using var host = await CreateApiAsync("trusted-host-secret");
        using var response = await HostPatch(host.Client, json, "trusted-host-secret");
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var reloaded = _db.Settings();
        await reloaded.LoadAsync(Token);
        Assert.False(reloaded.Current.Agent.AllowCommands);
        Assert.False(reloaded.Current.Agent.AllowShellCommands);
    }

    [Fact]
    public async Task Shell_permissions_stay_locked_on_ordinary_settings_but_subagents_can_be_switched_off()
    {
        await using var host = await CreateApiAsync("trusted-host-secret");
        using var refused = await host.Client.PutAsJsonAsync("/api/settings/agent", new { allowShellCommands = true }, Token);
        Assert.Equal(HttpStatusCode.OK, refused.StatusCode);
        using var body = JsonDocument.Parse(await refused.Content.ReadAsStringAsync(Token));
        Assert.Contains(body.RootElement.GetProperty("refused").EnumerateArray(), value => value.GetString() == "AllowShellCommands");
        using var allowed = await host.Client.PutAsJsonAsync("/api/settings/agent", new { allowSubagents = false }, Token);
        Assert.Equal(HttpStatusCode.OK, allowed.StatusCode);
        var reloaded = _db.Settings();
        await reloaded.LoadAsync(Token);
        Assert.False(reloaded.Current.Agent.AllowShellCommands);
        Assert.False(reloaded.Current.Agent.AllowSubagents);
    }

    private async Task<HttpResponseMessage> HostPatch(HttpClient client, string json, string? token)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/host/agent-permissions")
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json"),
        };
        if (token is not null)
        {
            request.Headers.Add("X-Aqvenor-Host-Token", token);
        }
        return await client.SendAsync(request, Token);
    }

    private async Task<ApiHost> CreateApiAsync(string? hostToken = null)
    {
        var settings = _db.Settings();
        await settings.LoadAsync(Token);
        var builder = WebApplication.CreateBuilder();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?> { ["HostToken"] = hostToken });
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Services.AddInfrastructure(builder.Configuration);
        builder.Services.AddSingleton<IAppPaths>(new AppPaths(Path.GetDirectoryName(_db.DatabasePath)!));
        builder.Services.AddSingleton<ISettingsService>(settings);
        builder.Services.AddSingleton<RunRegistry>();
        builder.Services.AddSingleton<GraphPersistence>();
        builder.Services.AddSingleton<GraphWriteRegistry>();
        builder.Services.AddSingleton<JsonCheckpointStore>();
        builder.Services.ConfigureHttpJsonOptions(options =>
            options.SerializerOptions.Converters.Add(new JsonStringEnumConverter()));
        builder.Services.AddSingleton(new SidecarToken("settings-endpoint-tests"));
        builder.Services.AddAuthentication(SidecarTokenHandler.SchemeName)
            .AddScheme<AuthenticationSchemeOptions, SidecarTokenHandler>(SidecarTokenHandler.SchemeName, _ => { });
        SidecarAuthorization.Configure(builder.Services);
        var app = builder.Build();
        app.UseAuthentication();
        app.UseAuthorization();
        DataEndpoints.Map(app);
        HostEndpoints.Map(app);
        await app.StartAsync(Token);
        var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
        var client = new HttpClient { BaseAddress = new Uri(address) };
        client.DefaultRequestHeaders.Authorization = new("Bearer", "settings-endpoint-tests");
        return new ApiHost(app, client);
    }

    private sealed record ApiHost(WebApplication App, HttpClient Client) : IAsyncDisposable
    {
        public async ValueTask DisposeAsync()
        {
            Client.Dispose();
            await App.DisposeAsync();
        }
    }
}
