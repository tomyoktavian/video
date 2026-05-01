import { useProjectStore } from './project-contract'

export function getCanvasSize(): { width: number; height: number } {
  const project = useProjectStore.getState().currentProject
  return {
    width: project?.metadata.width ?? 1920,
    height: project?.metadata.height ?? 1080,
  }
}
