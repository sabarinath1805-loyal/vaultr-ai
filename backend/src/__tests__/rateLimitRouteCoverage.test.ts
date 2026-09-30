import { describe, expect, it } from "vitest";
import type { RequestHandler, Router } from "express";
import { routeMounts } from "../app";
import {
  rateLimitClassOf,
  routeRatePolicy,
} from "../lib/rateLimit";

type RouteLayer = {
  name?: string;
  handle?: { stack?: RouteLayer[] } | RequestHandler;
  route?: {
    path: string | string[];
    methods: Record<string, boolean>;
    stack: Array<{ handle: RequestHandler }>;
  };
};

type RegisteredRoute = {
  method: string;
  path: string;
  requiresAuthentication: boolean;
  limiterClasses: string[];
  middlewareNames: string[];
};

function combinePath(prefix: string, suffix: string): string {
  const joined = `${prefix.replace(/\/$/, "")}/${suffix.replace(/^\//, "")}`;
  return joined.replace(/\/{2,}/g, "/") || "/";
}

function enumerateRouter(
  router: Router,
  prefix: string,
  inheritedAuthentication = false,
): RegisteredRoute[] {
  const routes: RegisteredRoute[] = [];
  let routerAuthentication = inheritedAuthentication;
  const layers = (router as unknown as { stack: RouteLayer[] }).stack;

  for (const layer of layers) {
    if (layer.route) {
      const routePaths = Array.isArray(layer.route.path)
        ? layer.route.path
        : [layer.route.path];
      const middleware = layer.route.stack.map((item) => item.handle);
      const requiresAuthentication =
        routerAuthentication ||
        middleware.some((handle) =>
          ["requireAuth", "requireAuthWithBody", "requireAuthenticatedBody"].includes(
            handle.name,
          ),
        );
      const limiterClasses = middleware
        .map((handle) => rateLimitClassOf(handle))
        .filter((value): value is NonNullable<typeof value> => Boolean(value));
      // Production requireAuth and requireAuthenticatedBody both apply the
      // generic per-user counter even when a route has a narrower class too.
      if (requiresAuthentication) limiterClasses.push("general");
      for (const method of Object.keys(layer.route.methods)) {
        if (!layer.route.methods[method]) continue;
        for (const routePath of routePaths) {
          routes.push({
            method: method.toUpperCase(),
            path: combinePath(prefix, routePath),
            requiresAuthentication,
            limiterClasses,
            middlewareNames: middleware.map((handle) => handle.name),
          });
        }
      }
      continue;
    }

    if (layer.name === "requireAuth") routerAuthentication = true;
    const nested = layer.handle as { stack?: RouteLayer[] } | undefined;
    if (nested?.stack) {
      routes.push(...enumerateRouter(nested as unknown as Router, prefix, routerAuthentication));
    }
  }
  return routes;
}

describe("rate-limit route coverage guard", () => {
  it("enumerates expensive mounted route families and requires auth plus their declared limiter", () => {
    const routes = routeMounts.flatMap((mount) => {
      const prefixes = Array.isArray(mount.path) ? mount.path : [mount.path];
      return prefixes.flatMap((prefix) => enumerateRouter(mount.router, prefix));
    });

    expect(routes.length).toBeGreaterThan(250);
    for (const route of routes) {
      const policy = routeRatePolicy(route.method, route.path);
      if (!policy) continue;

      expect(
        route.requiresAuthentication,
        `${route.method} ${route.path} (${policy.family}) must authenticate`,
      ).toBe(policy.requiresAuthentication);

      if (policy.class) {
        expect(
          route.limiterClasses,
          `${route.method} ${route.path} needs the ${policy.class} identity limiter`,
        ).toContain(policy.class);
      }

      if (policy.bodyLimit) {
        expect(
          route.middlewareNames,
          `${route.method} ${route.path} must authenticate before the ${policy.bodyLimit} parser`,
        ).toContain("requireAuthWithBody");
      }
    }

    const exportAliases = routes.filter(
      (route) =>
        route.method === "POST" &&
        ["/user/exports", "/users/exports"].includes(route.path),
    );
    expect(exportAliases.map((route) => route.path).sort()).toEqual([
      "/user/exports",
      "/users/exports",
    ]);
    expect(exportAliases.every((route) => route.limiterClasses.includes("export"))).toBe(
      true,
    );
  });
});
