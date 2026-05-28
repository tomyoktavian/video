export interface OpenAiCompatibleVisionConfig {
  baseUrl: string
  apiKey: string
  model: string
}

type ConfigGetter = () => OpenAiCompatibleVisionConfig

let configGetter: ConfigGetter | null = null

export function setOpenAiCompatibleVisionConfigGetter(getter: ConfigGetter): void {
  configGetter = getter
}

export function getOpenAiCompatibleVisionConfig(): OpenAiCompatibleVisionConfig {
  if (!configGetter) {
    return { baseUrl: '', apiKey: '', model: '' }
  }
  return configGetter()
}
