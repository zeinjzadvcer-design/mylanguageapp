import { useState } from "react";
import { useGetVocabulary } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, Volume2, BookMarked } from "lucide-react";
import { useI18n } from "@/lib/i18n";

export default function Vocabulary() {
  const { data: vocabulary, isLoading, error } = useGetVocabulary();
  const [searchTerm, setSearchTerm] = useState("");
  const { t } = useI18n();
  const v = t.vocabulary;

  if (isLoading) {
    return (
      <div className="p-4 md:p-8 max-w-4xl mx-auto space-y-6">
        <Skeleton className="h-10 w-48 rounded-xl" />
        <Skeleton className="h-12 w-full rounded-xl" />
        <div className="space-y-4">
          {[1,2,3,4,5].map(i => <Skeleton key={i} className="h-32 rounded-xl" />)}
        </div>
      </div>
    );
  }

  if (error || !vocabulary) {
    return (
      <div className="p-8 text-center text-destructive">
        {v.loadError}
      </div>
    );
  }

  const filteredVocabulary = vocabulary.filter(item => 
    item.word.toLowerCase().includes(searchTerm.toLowerCase()) || 
    item.translation.includes(searchTerm)
  );

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-bold text-foreground flex items-center gap-3">
            <BookMarked className="h-8 w-8 text-primary" />
            {v.title}
          </h1>
          <p className="text-muted-foreground mt-2">
            {v.subtitle}
          </p>
        </div>
        <div className="relative w-full md:w-72">
          <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
          <Input 
            placeholder={v.search} 
            className="pe-4 ps-10 h-12 rounded-xl bg-card border-border"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
      </div>

      <div className="space-y-4">
        {filteredVocabulary.length === 0 ? (
          <div className="text-center p-12 bg-secondary/50 rounded-2xl border border-border text-muted-foreground">
            {v.noMatch}
          </div>
        ) : (
          filteredVocabulary.map((vocab) => (
            <Card key={vocab.id} className="overflow-hidden border-2 border-border hover:border-primary/30 transition-colors">
              <CardContent className="p-0 flex flex-col sm:flex-row items-stretch">
                <button aria-label={v.listen} className="w-full sm:w-16 h-12 sm:h-auto bg-primary/5 flex items-center justify-center border-b sm:border-b-0 sm:border-s border-border hover:bg-primary/10 transition-colors shrink-0">
                  <Volume2 className="h-6 w-6 text-primary" />
                </button>
                <div className="p-5 flex-1 w-full">
                  <div className="flex flex-col sm:flex-row justify-between items-start gap-2 mb-3">
                    <div className="text-2xl font-bold text-foreground font-serif" dir="ltr">{vocab.word}</div>
                    <div className="text-xl font-bold text-primary bg-primary/10 px-3 py-1 rounded-lg" dir="rtl">
                      {vocab.translation}
                    </div>
                  </div>
                  {vocab.pronunciation && (
                    <div className="text-sm text-muted-foreground mb-4 font-mono" dir="ltr">/{vocab.pronunciation}/</div>
                  )}
                  {vocab.definition && (
                    <p className="text-sm text-muted-foreground leading-relaxed mb-2" dir="ltr">
                      {vocab.definition}
                    </p>
                  )}
                  {vocab.exampleSentence && (
                    <div className="mt-4 pt-4 border-t border-border/50 space-y-2 text-left" dir="ltr">
                      <p className="text-md italic text-foreground leading-relaxed">{vocab.exampleSentence}</p>
                      {vocab.exampleSentenceAr && (
                        <p className="text-sm text-muted-foreground text-start" dir="rtl">{vocab.exampleSentenceAr}</p>
                      )}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
