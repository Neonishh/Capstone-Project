'use client';
import { ErrorState } from '@/components/ui';
export default function Error({ reset }: { error: Error; reset: () => void }) { return <div className="page"><ErrorState message="The page could not be rendered. Retry or return to Overview." retry={reset} /></div>; }
