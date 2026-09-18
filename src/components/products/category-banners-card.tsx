'use client';

import { readResponseJson } from '@/lib/http/response-json';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Image as ImageIcon, Loader2, Upload, X } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { uploadAccountMedia, MEDIA_MAX_BYTES_BY_KIND } from '@/lib/storage/upload-media';
import type { ProductCategory } from '@/types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type BannerField = 'banner_url' | 'banner_url_weekend';

/**
 * Banner image(s) per catalog category (migrations 141 + 143) — sent
 * by the AI when a guest asks about a whole category ("qué
 * habitaciones tienen", "precios de spa") instead of one specific
 * room/service. `banner_url` is the default/weekday image;
 * `banner_url_weekend` is an optional second image for a Friday–
 * Saturday rate — when both are set, the AI asks for the stay's date
 * and picks whichever applies. The images themselves (photos +
 * general prices) are designed outside the CRM; this card only
 * uploads and stores them.
 *
 * Hotel vertical only, for now (Angel, 2026-09-18: "de momento quiero
 * que quede solo... para las hoteleras") — self-gates on
 * `account.industry_vertical`, so it's a no-op include everywhere
 * else, same pattern as `InboxPatientCard` / `InboxReservationsCard`.
 */
export function CategoryBannersCard() {
  const t = useTranslations('Products.categoryBanners');
  const { account } = useAuth();
  const canManage = useCan('manage-products');
  const isHotel = (account?.industry_vertical ?? 'generic') === 'hotel';

  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  useEffect(() => {
    if (!isHotel) {
      setLoading(false);
      return;
    }
    let on = true;
    (async () => {
      try {
        const res = await fetch('/api/product-categories', { cache: 'no-store' });
        const body = await readResponseJson<{ categories?: ProductCategory[] }>(res);
        if (on) setCategories(body?.categories ?? []);
      } catch {
        if (on) setCategories([]);
      } finally {
        if (on) setLoading(false);
      }
    })();
    return () => {
      on = false;
    };
  }, [isHotel]);

  async function handleFile(category: ProductCategory, field: BannerField, file: File) {
    if (!file.type.startsWith('image/')) {
      toast.error(t('invalidImage'));
      return;
    }
    if (file.size > MEDIA_MAX_BYTES_BY_KIND.image) {
      toast.error(t('fileTooLarge'));
      return;
    }
    const key = `${category.id}:${field}`;
    setBusyKey(key);
    try {
      const { publicUrl } = await uploadAccountMedia('catalog-media', file);
      const res = await fetch(`/api/product-categories/${category.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: publicUrl }),
      });
      if (!res.ok) {
        const body = await readResponseJson(res).catch(() => ({}));
        toast.error(body.error || t('uploadFailed'));
        return;
      }
      setCategories((prev) =>
        prev.map((c) => (c.id === category.id ? { ...c, [field]: publicUrl } : c)),
      );
      toast.success(t('uploadSuccess'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('uploadFailed'));
    } finally {
      setBusyKey(null);
    }
  }

  async function handleRemove(category: ProductCategory, field: BannerField) {
    const key = `${category.id}:${field}`;
    setBusyKey(key);
    try {
      const res = await fetch(`/api/product-categories/${category.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: null }),
      });
      if (!res.ok) {
        const body = await readResponseJson(res).catch(() => ({}));
        toast.error(body.error || t('uploadFailed'));
        return;
      }
      setCategories((prev) =>
        prev.map((c) => (c.id === category.id ? { ...c, [field]: null } : c)),
      );
      toast.success(t('removeSuccess'));
    } finally {
      setBusyKey(null);
    }
  }

  if (!isHotel || loading || categories.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-muted-foreground text-sm">{t('description')}</p>
        <ul className="divide-border divide-y">
          {categories.map((category) => (
            <li key={category.id} className="space-y-2 py-3 first:pt-0 last:pb-0">
              <span className="text-foreground block text-sm font-medium">
                {category.name}
              </span>
              <BannerSlot
                label={t('weekdaySlot')}
                url={category.banner_url ?? null}
                busy={busyKey === `${category.id}:banner_url`}
                canManage={canManage}
                onUpload={(file) => handleFile(category, 'banner_url', file)}
                onRemove={() => handleRemove(category, 'banner_url')}
                uploadLabel={category.banner_url ? t('replaceBtn') : t('uploadBtn')}
                removeLabel={t('removeBtn')}
                altText={category.name}
              />
              <BannerSlot
                label={t('weekendSlot')}
                url={category.banner_url_weekend ?? null}
                busy={busyKey === `${category.id}:banner_url_weekend`}
                canManage={canManage}
                onUpload={(file) => handleFile(category, 'banner_url_weekend', file)}
                onRemove={() => handleRemove(category, 'banner_url_weekend')}
                uploadLabel={category.banner_url_weekend ? t('replaceBtn') : t('uploadBtn')}
                removeLabel={t('removeBtn')}
                altText={category.name}
              />
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function BannerSlot({
  label,
  url,
  busy,
  canManage,
  onUpload,
  onRemove,
  uploadLabel,
  removeLabel,
  altText,
}: {
  label: string;
  url: string | null;
  busy: boolean;
  canManage: boolean;
  onUpload: (file: File) => void;
  onRemove: () => void;
  uploadLabel: string;
  removeLabel: string;
  altText: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="bg-muted flex h-12 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md">
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element -- Supabase Storage URL, same convention as product-form.tsx
          <img src={url} alt={altText} className="h-full w-full object-cover" />
        ) : (
          <ImageIcon className="text-muted-foreground/50 size-5" />
        )}
      </div>
      <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">{label}</span>
      {canManage && (
        <div className="flex shrink-0 items-center gap-1.5">
          <label>
            <input
              type="file"
              accept="image/*"
              disabled={busy}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onUpload(file);
                e.target.value = '';
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={(e) =>
                (e.currentTarget.previousElementSibling as HTMLInputElement)?.click()
              }
            >
              {busy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Upload className="size-3.5" />
              )}
              {uploadLabel}
            </Button>
          </label>
          {url && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={onRemove}
              aria-label={removeLabel}
              className="text-muted-foreground hover:text-destructive px-2"
            >
              <X className="size-3.5" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
