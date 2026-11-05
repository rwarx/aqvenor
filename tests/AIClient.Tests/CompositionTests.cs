using AIClient.App;
using AIClient.App.Graph;
using AIClient.App.Services;
using AIClient.Application.Interfaces;
using AIClient.Domain.Interfaces;
using AIClient.Application.Services;
using AIClient.Infrastructure;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace AIClient.Tests;

/// <summary>
/// The composition root's deliberate last-wins overrides. <c>AddInfrastructure</c> installs
/// the safe defaults - deny every approval, keep plans in the transcript - and
/// <c>AddAppServices</c> replaces both, purely because the host calls it second.
/// </summary>
/// <remarks>
/// Swapping the call order or switching those registrations to <c>TryAdd</c> would compile,
/// start and run: the agent would simply refuse every write with nothing in any log to
/// explain why, and Plan canvas would degrade to Plan while telling the model there is no
/// canvas. The comments at the registration sites say this; the test makes the comment true.
/// </remarks>
public sealed class CompositionTests
{
    [Fact]
    public void The_documented_tool_and_provider_counts_match_the_container()
    {
        // ARCHITECTURE.md documents "24 tools" and the READMEs document eight built-in
        // providers. If either registration list changes, this test fails and the docs
        // must change with it - silent drift was the finding (AQV-ARCH-01).
        var services = new ServiceCollection().AddInfrastructure(new ConfigurationBuilder().Build());

        var tools = services.Count(d => d.ServiceType == typeof(IAgentTool));
        var providers = services.Count(d => d.ServiceType == typeof(IAIProvider));

        Assert.Equal(24, tools);
        Assert.Equal(8, providers);
    }

    [Fact]
    public void Infrastructure_alone_keeps_the_safe_defaults()
    {
        var services = new ServiceCollection().AddInfrastructure(new ConfigurationBuilder().Build());

        using var provider = services.BuildServiceProvider();

        Assert.IsType<DenyingAgentApproval>(provider.GetRequiredService<IAgentApproval>());
        Assert.IsType<TranscriptPlanSink>(provider.GetRequiredService<IAgentPlanSink>());
    }

    [Fact]
    public void AddAppServices_wins_over_the_infrastructure_defaults()
    {
        var services = new ServiceCollection();
        services.AddInfrastructure(new ConfigurationBuilder().Build());
        services.AddAppServices();

        using var provider = services.BuildServiceProvider();

        Assert.IsType<AgentApprovalService>(provider.GetRequiredService<IAgentApproval>());
        Assert.IsType<CanvasPlanSink>(provider.GetRequiredService<IAgentPlanSink>());
    }
}
