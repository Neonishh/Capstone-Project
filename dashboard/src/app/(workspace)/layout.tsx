import { redirect } from 'next/navigation';
import { AccessError, requireAccess } from '@/lib/access';
export const dynamic = 'force-dynamic';
export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  try { await requireAccess(); }
  catch (error) { if (error instanceof AccessError) redirect('/login'); throw error; }
  return children;
}
