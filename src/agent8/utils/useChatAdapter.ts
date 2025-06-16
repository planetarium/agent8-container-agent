import { parseDataStreamPart } from "ai";

export class UseChatAdapter {
  static parseDataStream(rawContent: string): {
    annotations: Array<{ type: string, data: any }>;
    textContent: string;
    metadata: any;
  } {
    const lines = rawContent.split('\n').filter(line => line.trim());
    const annotations: Array<{ type: string, data: any }> = [];
    const textChunks: string[] = [];
    let metadata: any = {};

    for (const line of lines) {
      try {
        const parsedPart = parseDataStreamPart(line);

        switch (parsedPart.type) {
          case 'text':
            textChunks.push(parsedPart.value);
            break;
          case 'data':
            if (Array.isArray(parsedPart.value)) {
              // Progress and other annotations come as data arrays
              parsedPart.value.forEach((item: any) => {
                if (item.type === 'progress') {
                  annotations.push({ type: 'progress', data: item });
                } else {
                  annotations.push({ type: 'annotation', data: item });
                }
              });
            }
            break;
          case 'message_annotations':
            if (Array.isArray(parsedPart.value)) {
              parsedPart.value.forEach((annotation: any) => {
                annotations.push({ type: 'annotation', data: annotation });
              });
            }
            break;
          case 'finish_message':
          case 'error':
            if (typeof parsedPart.value === 'object' && parsedPart.value !== null) {
              metadata = { ...metadata, ...parsedPart.value };
            }
            break;
        }
      } catch (error) {
        // Fallback to manual parsing for non-standard lines
        if (line.startsWith('0:')) {
          const text = line.substring(2);
          try {
            const parsed = JSON.parse(text);
            textChunks.push(parsed);
          } catch {
            textChunks.push(text);
          }
        } else if (line.startsWith('2:')) {
          try {
            const data = JSON.parse(line.substring(2));
            annotations.push({ type: 'progress', data });
          } catch (parseError) {
            console.warn('[UseChatAdapter] Failed to parse progress annotation:', parseError);
          }
        } else if (line.startsWith('8:')) {
          try {
            const data = JSON.parse(line.substring(2));
            annotations.push({ type: 'annotation', data });
          } catch (parseError) {
            console.warn('[UseChatAdapter] Failed to parse annotation:', parseError);
          }
        } else if (line.startsWith('f:') || line.startsWith('e:') || line.startsWith('d:')) {
          try {
            const data = JSON.parse(line.substring(2));
            metadata = { ...metadata, ...data };
          } catch (parseError) {
            console.warn('[UseChatAdapter] Failed to parse metadata:', parseError);
          }
        }
      }
    }

    return {
      annotations,
      textContent: textChunks.join(''),
      metadata
    };
  }

  static validateDataStream(rawContent: string): boolean {
    const lines = rawContent.split('\n');
    let hasTextContent = false;
    let hasMetadata = false;

    for (const line of lines) {
      if (line.startsWith('0:')) hasTextContent = true;
      if (line.startsWith('f:') || line.startsWith('e:') || line.startsWith('d:')) hasMetadata = true;
    }

    return hasTextContent && hasMetadata;
  }

  static extractStats(rawContent: string): {
    totalLines: number;
    textLines: number;
    annotationLines: number;
    metadataLines: number;
  } {
    const lines = rawContent.split('\n');
    return {
      totalLines: lines.length,
      textLines: lines.filter(line => line.startsWith('0:')).length,
      annotationLines: lines.filter(line => line.startsWith('2:') || line.startsWith('8:')).length,
      metadataLines: lines.filter(line => line.startsWith('f:') || line.startsWith('e:') || line.startsWith('d:')).length,
    };
  }
}
