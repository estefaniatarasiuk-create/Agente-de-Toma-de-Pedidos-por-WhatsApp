export function ComingSoon({ title, phase }: { title: string; phase: string }) {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-semibold text-gray-900">{title}</h1>
      <div className="mt-6 rounded-lg border border-dashed border-gray-300 bg-white p-8 text-center">
        <p className="text-sm text-gray-600">
          Esta sección se construye en la <span className="font-medium">{phase}</span>.
        </p>
      </div>
    </div>
  );
}
