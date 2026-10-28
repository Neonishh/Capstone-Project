import Link from 'next/link';
import { EmptyState } from '@/components/ui';
export default function NotFound() { return <EmptyState title="Page not found" description="That evidence page does not exist." action={<Link className="button" href="/">Back to Overview</Link>} />; }
