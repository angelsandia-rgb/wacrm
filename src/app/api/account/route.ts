// ============================================================
// /api/account
//
//   GET   — current caller's account + role. Any member.
//   PATCH — update the account: name, and the public-catalog
//           handle (`catalog_slug`) + banner (`catalog_banner_url`).
//           Admin+.
//
// Why both verbs share a route file
//   They speak about the same singular resource (the caller's
//   account) and reuse the same `requireRole` plumbing. Splitting
//   them across files would duplicate the `account_id` lookup
//   without buying anything.
// ============================================================

import { NextResponse } from "next/server";

import {
  requireRole,
  getCurrentAccount,
  toErrorResponse,
} from "@/lib/auth/account";
import {
  checkSharedRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";
import { slugifyCatalog, isValidCatalogSlug } from "@/lib/catalog/slug";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    return NextResponse.json({
      account: ctx.account,
      role: ctx.role,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

const MAX_NAME_LEN = 80;
const MAX_URL_LEN = 2048;

export async function PATCH(request: Request) {
  try {
    const ctx = await requireRole("admin");

    // Per-user limit on admin-class mutations. Bounds accidental
    // abuse (script run in a loop) and a compromised admin session
    // spamming updates. Each admin endpoint keys its own bucket so
    // one route doesn't starve another.
    const limit = await checkSharedRateLimit(
      `admin:account-update:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as
      | { name?: unknown; catalog_slug?: unknown; catalog_banner_url?: unknown }
      | null;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }

    const patch: Record<string, unknown> = {};

    if (body.name !== undefined) {
      if (typeof body.name !== "string") {
        return NextResponse.json(
          { error: "'name' must be a string" },
          { status: 400 },
        );
      }
      const name = body.name.trim();
      if (name.length === 0) {
        return NextResponse.json(
          { error: "Account name cannot be empty" },
          { status: 400 },
        );
      }
      if (name.length > MAX_NAME_LEN) {
        return NextResponse.json(
          { error: `Account name must be ${MAX_NAME_LEN} characters or fewer` },
          { status: 400 },
        );
      }
      patch.name = name;
    }

    if (body.catalog_slug !== undefined) {
      if (typeof body.catalog_slug !== "string") {
        return NextResponse.json(
          { error: "'catalog_slug' must be a string" },
          { status: 400 },
        );
      }
      const raw = body.catalog_slug.trim();
      if (raw === "") {
        // Clearing the slug — the catalog stays reachable at /catalog/<uuid>.
        patch.catalog_slug = null;
      } else {
        const slug = slugifyCatalog(raw);
        if (!isValidCatalogSlug(slug)) {
          return NextResponse.json(
            {
              error:
                "El enlace debe tener entre 3 y 40 caracteres: solo letras, números y guiones.",
            },
            { status: 400 },
          );
        }
        patch.catalog_slug = slug;
      }
    }

    if (body.catalog_banner_url !== undefined) {
      if (typeof body.catalog_banner_url !== "string") {
        return NextResponse.json(
          { error: "'catalog_banner_url' must be a string" },
          { status: 400 },
        );
      }
      const url = body.catalog_banner_url.trim();
      if (url === "") {
        patch.catalog_banner_url = null;
      } else if (url.length > MAX_URL_LEN || !/^https?:\/\//i.test(url)) {
        return NextResponse.json(
          { error: "El banner debe ser una URL http(s) válida." },
          { status: 400 },
        );
      } else {
        patch.catalog_banner_url = url;
      }
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
    }

    // RLS allows this UPDATE because accounts_update requires
    // `is_account_member(id, 'admin')`, and requireRole already
    // guaranteed the caller is admin+.
    const { data, error } = await ctx.supabase
      .from("accounts")
      .update(patch)
      .eq("id", ctx.accountId)
      .select("id, name, catalog_slug, catalog_banner_url")
      .single();

    if (error) {
      // Unique index on lower(catalog_slug) — someone else took it.
      if (error.code === "23505") {
        return NextResponse.json(
          { error: "Ese enlace ya está en uso por otra empresa. Elige otro." },
          { status: 409 },
        );
      }
      console.error("[PATCH /api/account] update error:", error);
      return NextResponse.json(
        { error: "Failed to update account" },
        { status: 500 },
      );
    }

    return NextResponse.json({ account: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
