# Translation partials

Each `*.json` file here contributes a slice of the translation tree, keyed by
language code, and is deep-merged over the base locale files in `../`.

Shape:

```json
{
  "en": { "myFeature": { "title": "Title", "save": "Save" } },
  "es": { "myFeature": { "title": "Título", "save": "Guardar" } },
  "fr": { "myFeature": { "title": "Titre", "save": "Enregistrer" } },
  "de": { "myFeature": { "title": "Titel", "save": "Speichern" } },
  "pt-BR": { "myFeature": { "title": "Título", "save": "Salvar" } },
  "ja": { "myFeature": { "title": "タイトル", "save": "保存" } },
  "ko": { "myFeature": { "title": "제목", "save": "저장" } },
  "zh": { "myFeature": { "title": "标题", "save": "保存" } }
}
```

In components, reference them like any other key: `t('myFeature.title')`.

Supported language codes: `en`, `es`, `fr`, `de`, `pt-BR`, `ja`, `ko`, `zh`.
The merge runs at startup in `src/i18n/index.ts`.
