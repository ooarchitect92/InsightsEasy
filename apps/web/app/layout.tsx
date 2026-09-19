import type {Metadata} from 'next';
import './styles.css';
export const metadata:Metadata={title:'InsightsEasy · Marketing to revenue',description:'Five connected workflows with traceable business outcomes.'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en"><body>{children}</body></html>;}
