"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import {
  FileText,
  Image as ImageIcon,
  Globe,
  Loader2,
  Upload,
  X,
  ArrowUp,
  ArrowDown,
  ExternalLink,
  MessageSquareText,
  UtensilsCrossed,
  Link as LinkIcon,
  Copy,
  Check,
} from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { uploadAccountMedia, MEDIA_MAX_BYTES_BY_KIND } from "@/lib/storage/upload-media";
import { slugifyCatalog, isValidCatalogSlug } from "@/lib/catalog/slug";
import { readResponseJson } from "@/lib/http/response-json";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { SettingsPanelHead } from "@/components/settings/settings-panel-head";

type CatalogMode = "digital" | "pdf" | "photos";
type QuoteMode = "pdf" | "message";

const MAX_CATALOG_FILE_BYTES = 10 * 1024 * 1024; // matches the catalog-media bucket cap (migration 068)

interface CatalogRow {
  catalog_delivery_mode: CatalogMode;
  catalog_pdf_url: string | null;
  catalog_photo_urls: string[] | null;
  quote_delivery_mode: QuoteMode;
  restaurant_menu_url: string | null;
}

/**
 * Products → Catalog tab. Lets the owner pick how the catalog gets
 * delivered to a customer (digital page / PDF / photos) and, for the
 * PDF/photos modes, upload their own existing catalog file(s) — never
 * generated from product records, by design (see docs bitácora entry
 * for this feature). `products` (the Products tab) stays the separate
 * database the team/AI search when a customer names an item.
 */
export function CatalogDeliverySettings() {
  const t = useTranslations("Products.catalog");
  const { accountId, account, canEditSettings, profileLoading, refreshProfile } = useAuth();
  const isHotel = account?.industry_vertical === "hotel";
  const supabase = createClient();

  // Public link (`catalog_slug`) + banner (`catalog_banner_url`) — both
  // live on `account` already, saved via PATCH /api/account (slug needs
  // uniqueness + format validation the direct client update can't give).
  const [slug, setSlug] = useState("");
  const [bannerUrl, setBannerUrl] = useState("");
  const [bannerUploading, setBannerUploading] = useState(false);
  const [brandingSaving, setBrandingSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setSlug(account?.catalog_slug ?? "");
    setBannerUrl(account?.catalog_banner_url ?? "");
  }, [account?.catalog_slug, account?.catalog_banner_url]);

  const publicBase =
    (process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, "") ||
      (typeof window !== "undefined" ? window.location.origin : "")) ?? "";
  const publicCatalogUrl = slug.trim()
    ? `${publicBase}/c/${slug.trim()}`
    : `${publicBase}/catalog/${accountId ?? ""}`;
  const brandingDirty =
    slug.trim() !== (account?.catalog_slug ?? "") ||
    bannerUrl.trim() !== (account?.catalog_banner_url ?? "");

  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<CatalogMode>("digital");
  const [quoteMode, setQuoteMode] = useState<QuoteMode>("pdf");
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [photoUrls, setPhotoUrls] = useState<string[]>([]);
  const [menuUrl, setMenuUrl] = useState("");
  const [uploading, setUploading] = useState(false);
  const [menuUploading, setMenuUploading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Original values, to know whether Save has anything to do.
  const [original, setOriginal] = useState<{
    mode: CatalogMode;
    quoteMode: QuoteMode;
    pdfUrl: string | null;
    photoUrls: string[];
    menuUrl: string;
  }>({
    mode: "digital",
    quoteMode: "pdf",
    pdfUrl: null,
    photoUrls: [],
    menuUrl: "",
  });

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      const { data } = await supabase
        .from("accounts")
        .select("catalog_delivery_mode, catalog_pdf_url, catalog_photo_urls, quote_delivery_mode, restaurant_menu_url")
        .eq("id", accountId)
        .maybeSingle<CatalogRow>();
      if (cancelled) return;
      const loadedMode = data?.catalog_delivery_mode ?? "digital";
      const loadedQuoteMode = data?.quote_delivery_mode ?? "pdf";
      const loadedPdf = data?.catalog_pdf_url ?? null;
      const loadedPhotos = data?.catalog_photo_urls ?? [];
      const loadedMenu = data?.restaurant_menu_url ?? "";
      setMode(loadedMode);
      setQuoteMode(loadedQuoteMode);
      setPdfUrl(loadedPdf);
      setPhotoUrls(loadedPhotos);
      setMenuUrl(loadedMenu);
      setOriginal({ mode: loadedMode, quoteMode: loadedQuoteMode, pdfUrl: loadedPdf, photoUrls: loadedPhotos, menuUrl: loadedMenu });
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, supabase]);

  const dirty =
    mode !== original.mode ||
    quoteMode !== original.quoteMode ||
    pdfUrl !== original.pdfUrl ||
    menuUrl.trim() !== original.menuUrl ||
    photoUrls.length !== original.photoUrls.length ||
    photoUrls.some((u, i) => u !== original.photoUrls[i]);

  async function handlePdfFile(file: File) {
    if (file.type !== "application/pdf") {
      toast.error(t("invalidPdf"));
      return;
    }
    if (file.size > MAX_CATALOG_FILE_BYTES) {
      toast.error(t("fileTooLarge"));
      return;
    }
    setUploading(true);
    try {
      const { publicUrl } = await uploadAccountMedia("catalog-media", file);
      setPdfUrl(publicUrl);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("uploadFailed"));
    } finally {
      setUploading(false);
    }
  }

  async function handleMenuFile(file: File) {
    if (file.type !== "application/pdf") {
      toast.error(t("invalidPdf"));
      return;
    }
    if (file.size > MAX_CATALOG_FILE_BYTES) {
      toast.error(t("fileTooLarge"));
      return;
    }
    setMenuUploading(true);
    try {
      const { publicUrl } = await uploadAccountMedia("catalog-media", file);
      setMenuUrl(publicUrl);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("uploadFailed"));
    } finally {
      setMenuUploading(false);
    }
  }

  async function handlePhotoFiles(files: FileList) {
    const list = Array.from(files);
    setUploading(true);
    try {
      const uploaded: string[] = [];
      for (const file of list) {
        if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
          toast.error(t("invalidImage"));
          continue;
        }
        if (file.size > MEDIA_MAX_BYTES_BY_KIND.image) {
          toast.error(t("fileTooLarge"));
          continue;
        }
        const { publicUrl } = await uploadAccountMedia("catalog-media", file);
        uploaded.push(publicUrl);
      }
      if (uploaded.length > 0) {
        setPhotoUrls((prev) => [...prev, ...uploaded]);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("uploadFailed"));
    } finally {
      setUploading(false);
    }
  }

  function movePhoto(index: number, direction: -1 | 1) {
    setPhotoUrls((prev) => {
      const next = [...prev];
      const target = index + direction;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function removePhoto(index: number) {
    setPhotoUrls((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSave() {
    if (!accountId || !dirty) return;
    setSaving(true);
    try {
      const trimmedMenu = menuUrl.trim();
      const { error } = await supabase
        .from("accounts")
        .update({
          catalog_delivery_mode: mode,
          catalog_pdf_url: pdfUrl,
          catalog_photo_urls: photoUrls,
          quote_delivery_mode: quoteMode,
          restaurant_menu_url: trimmedMenu || null,
        })
        .eq("id", accountId);
      if (error) {
        toast.error(t("saveFailed"));
        return;
      }
      setMenuUrl(trimmedMenu);
      setOriginal({ mode, quoteMode, pdfUrl, photoUrls, menuUrl: trimmedMenu });
      toast.success(t("saveSuccess"));
    } finally {
      setSaving(false);
    }
  }

  async function handleBannerFile(file: File) {
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      toast.error(t("invalidImage"));
      return;
    }
    if (file.size > MEDIA_MAX_BYTES_BY_KIND.image) {
      toast.error(t("fileTooLarge"));
      return;
    }
    setBannerUploading(true);
    try {
      const { publicUrl } = await uploadAccountMedia("catalog-media", file);
      setBannerUrl(publicUrl);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("uploadFailed"));
    } finally {
      setBannerUploading(false);
    }
  }

  async function handleSaveBranding() {
    if (!brandingDirty) return;
    const cleanSlug = slug.trim() ? slugifyCatalog(slug) : "";
    if (cleanSlug && !isValidCatalogSlug(cleanSlug)) {
      toast.error(t("publicLinkHint"));
      return;
    }
    setBrandingSaving(true);
    try {
      const res = await fetch("/api/account", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          catalog_slug: cleanSlug,
          catalog_banner_url: bannerUrl.trim(),
        }),
      });
      const data = await readResponseJson<{ error?: string }>(res).catch(() => ({}) as { error?: string });
      if (!res.ok) {
        toast.error(data?.error || t("saveFailed"));
        return;
      }
      setSlug(cleanSlug);
      await refreshProfile();
      toast.success(t("saveSuccess"));
    } catch {
      toast.error(t("saveFailed"));
    } finally {
      setBrandingSaving(false);
    }
  }

  async function copyPublicLink() {
    try {
      await navigator.clipboard.writeText(publicCatalogUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error(t("uploadFailed"));
    }
  }

  const disabled = !canEditSettings || profileLoading || loading;

  const MODES: { value: CatalogMode; label: string; icon: typeof Globe }[] = [
    { value: "digital", label: t("modeDigital"), icon: Globe },
    { value: "pdf", label: t("modePdf"), icon: FileText },
    { value: "photos", label: t("modePhotos"), icon: ImageIcon },
  ];

  const QUOTE_MODES: {
    value: QuoteMode;
    label: string;
    hint: string;
    icon: typeof Globe;
  }[] = [
    { value: "pdf", label: t("quoteModePdf"), hint: t("quoteModePdfHint"), icon: FileText },
    {
      value: "message",
      label: t("quoteModeMessage"),
      hint: t("quoteModeMessageHint"),
      icon: MessageSquareText,
    },
  ];

  return (
    <section className="max-w-2xl animate-in fade-in-50 duration-200 space-y-6">
      <SettingsPanelHead title={t("title")} description={t("description")} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <LinkIcon className="size-4 text-primary shrink-0" />
            {t("publicLinkTitle")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{t("publicLinkDesc")}</p>

          <div className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-sm">
            <span className="flex-1 truncate text-foreground">{publicCatalogUrl}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={copyPublicLink}
              title={copied ? t("copied") : t("copy")}
            >
              {copied ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
            </Button>
          </div>

          <div className="space-y-1.5">
            <Label className="text-muted-foreground">{t("publicLinkLabel")}</Label>
            <div className="flex items-center gap-1.5">
              <span className="shrink-0 text-sm text-muted-foreground">/c/</span>
              <Input
                value={slug}
                disabled={disabled}
                placeholder="mi-empresa"
                onChange={(e) => setSlug(e.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground">{t("publicLinkHint")}</p>
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground">{t("bannerLabel")}</Label>
            <p className="text-xs text-muted-foreground">{t("bannerHint")}</p>
            {bannerUrl.trim() ? (
              <div className="overflow-hidden rounded-md border border-border">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={bannerUrl.trim()} alt="" className="h-28 w-full object-cover" />
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">{t("bannerNone")}</p>
            )}
            <div className="flex flex-wrap gap-2">
              <label>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  disabled={disabled || bannerUploading}
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handleBannerFile(file);
                    e.target.value = "";
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={disabled || bannerUploading}
                  onClick={(e) => (e.currentTarget.previousElementSibling as HTMLInputElement)?.click()}
                >
                  {bannerUploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
                  {bannerUrl.trim() ? t("bannerReplaceBtn") : t("bannerUploadBtn")}
                </Button>
              </label>
              {bannerUrl.trim() && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={disabled || bannerUploading}
                  onClick={() => setBannerUrl("")}
                >
                  <X className="size-4" />
                  {t("remove")}
                </Button>
              )}
            </div>
          </div>

          {canEditSettings && (
            <Button
              onClick={handleSaveBranding}
              disabled={brandingSaving || !brandingDirty || disabled}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {brandingSaving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t("saving")}
                </>
              ) : (
                t("save")
              )}
            </Button>
          )}
          {!canEditSettings && <p className="text-xs text-muted-foreground">{t("adminOnlyHint")}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-foreground">{t("modeLabel")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            {MODES.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value)}
                disabled={disabled}
                className={`flex items-center gap-2 rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                  mode === value ? "border-primary bg-primary/5" : "border-border hover:bg-muted"
                }`}
              >
                <Icon className="size-4 text-primary shrink-0" />
                <span className="text-sm font-medium text-foreground">{label}</span>
              </button>
            ))}
          </div>
          {!canEditSettings && <p className="text-xs text-muted-foreground">{t("adminOnlyHint")}</p>}

          {mode === "digital" && <p className="text-sm text-muted-foreground">{t("digitalHint")}</p>}

          {mode === "pdf" && (
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t("pdfLabel")}</Label>
              {pdfUrl ? (
                <div className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-sm">
                  <FileText className="size-4 text-primary shrink-0" />
                  <a
                    href={pdfUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 truncate text-foreground hover:underline"
                  >
                    {t("viewCurrent")}
                  </a>
                  <ExternalLink className="size-3.5 text-muted-foreground shrink-0" />
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">{t("pdfNone")}</p>
              )}
              <label>
                <input
                  type="file"
                  accept="application/pdf"
                  disabled={disabled || uploading}
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handlePdfFile(file);
                    e.target.value = "";
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={disabled || uploading}
                  onClick={(e) => (e.currentTarget.previousElementSibling as HTMLInputElement)?.click()}
                >
                  {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
                  {pdfUrl ? t("pdfReplaceBtn") : t("pdfUploadBtn")}
                </Button>
              </label>
            </div>
          )}

          {mode === "photos" && (
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t("photosLabel")}</Label>
              {photoUrls.length === 0 && <p className="text-xs text-muted-foreground">{t("photosNone")}</p>}
              {photoUrls.length > 0 && (
                <ul className="space-y-1.5">
                  {photoUrls.map((url, index) => (
                    <li
                      key={url}
                      className="flex items-center gap-2 rounded-md border border-border bg-muted px-2 py-1.5"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={url} alt="" className="size-8 rounded object-cover shrink-0" />
                      <span className="flex-1 truncate text-xs text-muted-foreground">{url.split("/").pop()}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={disabled || index === 0}
                        title={t("moveUp")}
                        onClick={() => movePhoto(index, -1)}
                      >
                        <ArrowUp className="size-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={disabled || index === photoUrls.length - 1}
                        title={t("moveDown")}
                        onClick={() => movePhoto(index, 1)}
                      >
                        <ArrowDown className="size-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={disabled}
                        title={t("remove")}
                        onClick={() => removePhoto(index)}
                      >
                        <X className="size-3.5" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <label>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  multiple
                  disabled={disabled || uploading}
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files && e.target.files.length > 0) void handlePhotoFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={disabled || uploading}
                  onClick={(e) => (e.currentTarget.previousElementSibling as HTMLInputElement)?.click()}
                >
                  {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
                  {t("photosAddBtn")}
                </Button>
              </label>
            </div>
          )}

        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-foreground">{t("quoteModeLabel")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {QUOTE_MODES.map(({ value, label, hint, icon: Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => setQuoteMode(value)}
                disabled={disabled}
                className={`flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                  quoteMode === value
                    ? "border-primary bg-primary/5"
                    : "border-border hover:bg-muted"
                }`}
              >
                <span className="flex items-center gap-2">
                  <Icon className="size-4 text-primary shrink-0" />
                  <span className="text-sm font-medium text-foreground">{label}</span>
                </span>
                <span className="text-xs text-muted-foreground">{hint}</span>
              </button>
            ))}
          </div>
          {!canEditSettings && (
            <p className="text-xs text-muted-foreground">{t("adminOnlyHint")}</p>
          )}
        </CardContent>
      </Card>

      {isHotel && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-foreground">
              <UtensilsCrossed className="size-4 text-primary shrink-0" />
              {t("menuLabel")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">{t("menuHint")}</p>
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t("menuUrlLabel")}</Label>
              <Input
                type="url"
                inputMode="url"
                placeholder="https://…/menu.pdf"
                value={menuUrl}
                disabled={disabled || menuUploading}
                onChange={(e) => setMenuUrl(e.target.value)}
              />
              {menuUrl.trim() && (
                <a
                  href={menuUrl.trim()}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
                >
                  <FileText className="size-3.5 shrink-0" />
                  {t("viewCurrent")}
                  <ExternalLink className="size-3 shrink-0" />
                </a>
              )}
            </div>
            <label>
              <input
                type="file"
                accept="application/pdf"
                disabled={disabled || menuUploading}
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleMenuFile(file);
                  e.target.value = "";
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled || menuUploading}
                onClick={(e) => (e.currentTarget.previousElementSibling as HTMLInputElement)?.click()}
              >
                {menuUploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
                {menuUrl.trim() ? t("menuReplaceBtn") : t("menuUploadBtn")}
              </Button>
            </label>
            {!canEditSettings && <p className="text-xs text-muted-foreground">{t("adminOnlyHint")}</p>}
          </CardContent>
        </Card>
      )}

      {canEditSettings && (
        <Button
          onClick={handleSave}
          disabled={saving || !dirty || disabled}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          {saving ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              {t("saving")}
            </>
          ) : (
            t("save")
          )}
        </Button>
      )}

      <p className="text-xs text-muted-foreground">{t("productsNote")}</p>
    </section>
  );
}
