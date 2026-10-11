import {Suspense} from 'react';
import Catalog from '@/components/Catalog';
export default function Home(){return <Suspense fallback={<div className="page-loading">Loading your next story…</div>}><Catalog/></Suspense>}
