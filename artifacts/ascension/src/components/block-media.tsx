/**
 * Plays the audio, or shows the image, attached to a quiz or lesson block.
 *
 * Blocks carried a media reference that nothing ever rendered: listening
 * questions told the student "الملف الصوتي غير متاح بعد" even with a file
 * attached, and an image-description question showed no image at all.
 *
 * The stored key is not fetchable on its own — the server signs a short-lived
 * URL per asset, so this resolves `referenceMediaId` on mount.
 */
import { useEffect, useState } from "react";
import { getPlaybackUrl } from "@/lib/media-api";
import { Loader2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";

export function BlockMedia({
  mediaId,
  kind,
  className = "",
}: {
  mediaId?: number | null;
  kind: "audio" | "image" | "video";
  className?: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const { t } = useI18n();

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setFailed(false);
    if (!mediaId) return;

    getPlaybackUrl(mediaId)
      .then((u) => { if (!cancelled) setUrl(u); })
      .catch(() => { if (!cancelled) setFailed(true); });

    return () => { cancelled = true; };
  }, [mediaId]);

  if (!mediaId) return null;

  if (failed) {
    return (
      <p className={`text-sm bg-muted/60 rounded-xl p-3 text-muted-foreground ${className}`}>
        {t.media.failed}
      </p>
    );
  }

  if (!url) {
    return (
      <div className={`flex items-center gap-2 text-sm text-muted-foreground ${className}`}>
        <Loader2 className="h-4 w-4 animate-spin" /> {t.common.loading}
      </div>
    );
  }

  if (kind === "image") {
    return (
      <img
        src={url}
        alt=""
        className={`w-full rounded-xl border border-border object-contain max-h-80 ${className}`}
      />
    );
  }

  if (kind === "video") {
    return <video controls src={url} className={`w-full rounded-xl ${className}`} />;
  }

  return <audio controls src={url} className={`w-full rounded-lg ${className}`} />;
}
