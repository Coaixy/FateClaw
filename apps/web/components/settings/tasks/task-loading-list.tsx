export function TaskLoadingList() {
  return (
    <div className="rounded-xl border border-hairline divide-y divide-hairline overflow-hidden">
      {[1, 2, 3].map((index) => (
        <div key={index} className="bg-surface-card px-5 py-4 animate-pulse">
          <div className="h-3.5 w-48 rounded bg-hairline mb-2.5" />
          <div className="flex gap-2">
            <div className="h-5 w-14 rounded-full bg-hairline" />
            <div className="h-5 w-16 rounded-full bg-hairline" />
          </div>
        </div>
      ))}
    </div>
  );
}
