import { parseCSV, processDataset } from './core';
self.onmessage = (event: MessageEvent) => {
  const { id, operation, args } = event.data;
  try {
    const result = operation === 'parse' ? parseCSV(args.text, args.name, args.delimiter) : processDataset(args.dataset, args.workspace);
    self.postMessage({ id, result });
  } catch (error) { self.postMessage({ id, error: error instanceof Error ? error.message : 'Не удалось обработать CSV' }); }
};
