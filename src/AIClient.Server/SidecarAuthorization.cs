using Microsoft.AspNetCore.Authorization;
using Microsoft.Extensions.DependencyInjection;

namespace AIClient.Server;

/// <summary>
/// The authorization policy that turns a route's missing annotation into a refusal.
/// </summary>
/// <remarks>
/// <para>
/// Authentication alone realising a header's absence as "no principal" is not
/// authorization: without an authorization policy, a route mapped without any
/// annotation is reachable without the token. The fallback policy closes that
/// hole: every route requires an authenticated user by default, so adding a
/// route can no longer silently publish it. The readiness probe is the only
/// route allowed to stay anonymous, and it says so explicitly.
/// </para>
/// </remarks>
public static class SidecarAuthorization
{
    public static void Configure(IServiceCollection services) => services.AddAuthorization(o => o.FallbackPolicy = new AuthorizationPolicyBuilder().RequireAuthenticatedUser().Build());
}
