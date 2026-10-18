import { VncViewer } from "@/components/VncViewer";

export default async function DesktopPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="h-screen">
      <VncViewer workspaceId={id} />
    </div>
  );
}
