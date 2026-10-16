export type DiagramColors = { bg: string; fg: string; line?: string; accent?: string; muted?: string; surface?: string; border?: string }
/** sequenceDiagram と xychart の SVG。ほかの図は null。 */
export function renderMermaidSvg(text: string, colors: DiagramColors, font: string): string | null
