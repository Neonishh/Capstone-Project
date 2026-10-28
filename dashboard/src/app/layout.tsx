import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Shell } from '@/components/shell';
import './globals.css';
export const metadata: Metadata = { title: { default: 'Capstone · QA Observatory', template: '%s · QA Observatory' }, description: 'Explore the evidence behind web and mobile testing experiments.' };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en" data-scroll-behavior="smooth" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: `try{document.documentElement.dataset.theme=localStorage.getItem('dashboard-theme')||'light'}catch{}` }} /></head><body><a href="#page-content" className="skip-link">Skip to content</a><Suspense><Shell>{children}</Shell></Suspense></body></html>;
}
