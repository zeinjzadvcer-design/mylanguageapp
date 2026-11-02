import { Link } from 'wouter';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { BrandLogo } from '@/components/brand';
import { useI18n } from '@/lib/i18n';

export default function NotFound() {
  const { t } = useI18n();

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background">
      <Card className="w-full max-w-md mx-4 text-center">
        <CardContent className="pt-8 pb-8 space-y-4">
          <BrandLogo className="justify-center" />
          <div className="text-5xl font-extrabold text-primary">404</div>
          <h1 className="text-2xl font-bold text-foreground">{t.notFound.title}</h1>
          <p className="text-sm text-muted-foreground">{t.notFound.body}</p>
          <Link href="/">
            <Button className="rounded-xl">{t.notFound.home}</Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
