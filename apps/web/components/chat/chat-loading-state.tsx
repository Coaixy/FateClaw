export function ChatLoadingState({ count = 4 }: { count?: number }) {
  return (
    <div className="space-y-4 max-w-3xl mx-auto px-3 py-4">
      {Array.from({ length: count }, (_, index) => (
        <div
          key={index}
          className={`flex items-end gap-2.5 ${index % 2 === 0 ? '' : 'flex-row-reverse'}`}
        >
          <div
            className={`w-8 h-8 rounded-full animate-pulse shrink-0 ${
              index % 2 === 0 ? 'bg-surface-card' : 'bg-hairline'
            }`}
          />
          <div
            className={`rounded-2xl animate-pulse ${
              index % 2 === 0
                ? 'bg-surface-card w-52 h-12'
                : 'bg-hairline/50 w-36 h-9'
            }`}
          />
        </div>
      ))}
    </div>
  );
}
