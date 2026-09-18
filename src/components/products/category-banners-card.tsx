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

/**
 * One banner image per catalog category (migration 141) — sent by the
 * AI when a guest asks about a whole category ("qué habitaciones
 * tienen", "precios de spa") instead of one specific room/service. The
 * image itself (photos + general prices) is designed outside the CRM;
 * this card only uploads and stores it.
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
  const [uploadingId, setUploadingId] = useState<string | null>(null);

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

  async function handleFile(category: ProductCategory, file: File) {
    if (!file.type.startsWith('image/')) {
      toast.error(t('invalidImage'));
      return;
    }
    if (file.size > MEDIA_MAX_BYTES_BY_KIND.image) {
      toast.error(t('fileTooLarge'));
      return;
    }
    setUploadingId(category.id);
    try {
      const { publicUrl } = await uploadAccountMedia('catalog-media', file);
      const res = await fetch(`/api/product-categories/${category.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ banner_url: publicUrl }),
      });
      if (!res.ok) {
        const body = await readResponseJson(res).catch(() => ({}));
        toast.error(body.error || t('uploadFailed'));
        return;
      }
      setCategories((prev) =>
        prev.map((c) => (c.id === category.id ? { ...c, banner_url: publicUrl } : c)),
      );
      toast.success(t('uploadSuccess'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('uploadFailed'));
    } finally {
      setUploadingId(null);
    }
  }

  async function handleRemove(category: ProductCategory) {
    setUploadingId(category.id);
    try {
      const res = await fetch(`/api/product-categories/${category.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ banner_url: null }),
      });
      if (!res.ok) {
        const body = await readResponseJson(res).catch(() => ({}));
        toast.error(body.error || t('uploadFailed'));
        return;
      }
      setCategories((prev) =>
        prev.map((c) => (c.id === category.id ? { ...c, banner_url: null } : c)),
      );
      toast.success(t('removeSuccess'));
    } finally {
      setUploadingId(null);
    }
  }

  if (!isHotel || loading || categories.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-muted-foreground text-sm">{t('description')}</p>
        <ul className="divide-border divide-y">
          {categories.map((category) => {
            const busy = uploadingId === category.id;
            return (
              <li
                key={category.id}
                className="flex items-center gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div className="bg-muted flex h-12 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md">
                  {category.banner_url ? (
                    // eslint-disable-next-line @next/next/no-img-element -- Supabase Storage URL, same convention as product-form.tsx
                    <img
                      src={category.banner_url}
                      alt={category.name}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <ImageIcon className="text-muted-foreground/50 size-5" />
                  )}
                </div>
                <span className="text-foreground min-w-0 flex-1 truncate text-sm font-medium">
                  {category.name}
                </span>
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
                          if (file) void handleFile(category, file);
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
                        {category.banner_url ? t('replaceBtn') : t('uploadBtn')}
                      </Button>
                    </label>
                    {category.banner_url && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => handleRemove(category)}
                        aria-label={t('removeBtn')}
                        className="text-muted-foreground hover:text-destructive px-2"
                      >
                        <X className="size-3.5" />
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
