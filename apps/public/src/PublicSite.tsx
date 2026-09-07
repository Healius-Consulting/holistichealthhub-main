import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  Activity, ArrowRight, Brain, Check, ChevronDown, ChevronRight, ClipboardCheck, Clock3, Flower2,
  Globe2, HeartHandshake, HeartPulse, Leaf, MoonStar, Orbit, PackageCheck,
  ShieldCheck, ShieldPlus, Sparkles, Stethoscope, UserRoundCheck, Video,
} from 'lucide-react';
import './public-site.css';
import { posts } from './journalPosts';
import { PublicHeader, PublicLink } from './PublicHeader';
import { usePublicLocation } from './publicLocation';

const MARK = '/holistic-health-hub-mark.png';
const HERO_IMAGE = '/hhh-consultation-hero.jpg';
const ELIGIBILITY_IMAGE = '/hhh-eligibility-check.jpg';
const SPECIALIST_IMAGE = '/hhh-specialist-consult.jpg';
const PHARMACY_IMAGE = '/hhh-pharmacy-care.jpg';
const SUPPORT_IMAGE = '/hhh-ongoing-support.jpg';
const WELLBEING_IMAGE = '/hhh-wellbeing-couple.jpg';
const PAIN_IMAGE = '/hhh-condition-pain.jpg';
const NEUROLOGICAL_IMAGE = '/hhh-condition-neurological.jpg';
const PSYCHIATRIC_IMAGE = '/hhh-condition-psychiatric.jpg';
const OTHER_CONDITIONS_IMAGE = '/hhh-condition-other.jpg';
const TEAM_SPECIALIST_IMAGE = '/hhh-team-specialist.jpg';
const TEAM_PHARMACIST_IMAGE = '/hhh-team-pharmacist.jpg';
const TEAM_NURSE_IMAGE = '/hhh-team-nurse.jpg';

const CANONICAL_ORIGIN = 'https://holistichealthhub.live';
const ECOLOGI_PROFILE_HREF = 'https://ecologi.com/holistichealthhub?r=657837efdee615d57964704e';
const ECOLOGI_FUND_HREF = 'https://ecologi.com/holistichealthhub?gift=true&r=657837efdee615d57964704e';
const ECOLOGI_IMPACT_URL = 'https://public.ecologi.com/users/holistichealthhub/impact';
const ECOLOGI_TREES_FALLBACK = 10;

const steps = [
  {
    number: '01',
    kicker: 'Intake & Pre-Screening',
    title: 'Check eligibility',
    copy: 'Complete a short, secure form so Holistic Health Hub can review whether you may benefit from CBPM therapy. Your application stays with Holistic Health Hub first, including when you arrive through a pharmacy-specific link.',
    image: ELIGIBILITY_IMAGE,
    imageAlt: 'A patient privately completing a confidential eligibility pre-check at home',
    tag: 'Private intake review',
  },
  {
    number: '02',
    kicker: 'Clinical Assessment',
    title: 'Online consultation',
    copy: 'A doctor who specialises in your condition assesses you. After the consultation, a multi-disciplinary team (MDT) of doctors and pharmacists determines which CBPM treatment, if any, is clinically appropriate.',
    image: SPECIALIST_IMAGE,
    imageAlt: 'A consultant specialist physician discussing treatment options with a patient during a video assessment',
    tag: 'Consultant physician & MDT review',
  },
  {
    number: '03',
    kicker: 'Dispensing & Care',
    title: 'Receive treatment',
    copy: 'If prescribed, your prescription is sent to your nominated pharmacy, who contacts you to arrange payment and convenient delivery or pharmacy collection.',
    image: PHARMACY_IMAGE,
    imageAlt: 'A community pharmacist providing prescription guidance at the pharmacy',
    tag: 'Nominated community pharmacy',
  },
  {
    number: '04',
    kicker: 'Continuous Support',
    title: 'Ongoing support',
    copy: 'The quality of your care matters after the first appointment. Between Holistic Health Hub, your nominated pharmacy and the partnered clinic, support continues on your journey to health.',
    image: SUPPORT_IMAGE,
    imageAlt: 'A dedicated patient support specialist conducting an ongoing health follow-up',
    tag: 'Dedicated check-ins & reviews',
  },
] as const;

const conditionGroups = [
  {
    title: 'Pain',
    icon: <Activity aria-hidden="true" />,
    image: PAIN_IMAGE,
    imageAlt: 'A patient sitting quietly by a window at home, taking a moment during a long-term pain condition',
    imagePosition: 'center 28%',
    lead: 'For chronic and complex pain conditions where conventional treatments have not provided sufficient relief.',
    items: [
      'Arthritis', 'Back pain', 'Cancer-related pain', 'Chronic pain', 'Cluster headache',
      'Complex regional pain syndrome', 'Ehlers-Danlos syndromes', 'Endometriosis',
      'Fibromyalgia', 'Migraine', 'Musculoskeletal pain', 'Neuropathic pain', 'Sciatica',
    ],
  },
  {
    title: 'Neurological',
    icon: <Brain aria-hidden="true" />,
    image: NEUROLOGICAL_IMAGE,
    imageAlt: 'A specialist clinician listening to a patient during a neurological assessment',
    imagePosition: 'center 22%',
    lead: 'Specialist-assessed neurological indications evaluated under dedicated clinical protocols.',
    items: [
      'Autistic spectrum disorder', 'Epilepsy (adult and child)', 'Multiple sclerosis',
      'Parkinson’s disease', 'Tourette’s syndrome', 'Trigeminal neuralgia',
    ],
  },
  {
    title: 'Psychiatric',
    icon: <Flower2 aria-hidden="true" />,
    image: PSYCHIATRIC_IMAGE,
    imageAlt: 'A clinician and a patient talking in a calm, private consultation room',
    imagePosition: 'center 32%',
    lead: 'Targeted support for mental wellbeing under consultant psychiatric oversight.',
    items: [
      'ADHD', 'Agoraphobia', 'Anxiety', 'Depression', 'Insomnia',
      'Obsessive compulsive disorder', 'Post-traumatic stress disorder', 'Social phobia',
    ],
  },
  {
    title: 'Other conditions',
    icon: <ShieldPlus aria-hidden="true" />,
    image: OTHER_CONDITIONS_IMAGE,
    imageAlt: 'A nurse sitting with an older patient at home during a quiet care conversation',
    imagePosition: 'center 38%',
    lead: 'Gastrointestinal, palliative and specialised clinical indications reviewed individually.',
    items: [
      'Anorexia', 'Binge eating disorder', 'Bulimia nervosa', 'Cancer-related appetite loss',
      'Chemotherapy-induced nausea and vomiting', 'Crohn’s disease', 'Eating disorders',
      'Palliative care', 'Rare skin conditions', 'Ulcerative colitis',
    ],
  },
] as const;

const faqs = [
  ['Is medical cannabis legal in the UK?', 'Cannabis based products for medicinal use (CBPM) have been legal for medicinal purposes in the UK since November 2018. They require a valid prescription issued by a specialist doctor on the GMC Specialist Register.'],
  ['Are CBPMs safe?', 'Like all medicines, CBPMs can cause side effects and are not suitable for everyone. A specialist clinician weighs the potential benefits and risks for your specific circumstances and monitors your treatment plan on an ongoing basis.'],
  ['What can CBPMs be prescribed for?', 'A specialist may consider CBPMs for a range of conditions—including chronic pain, neurological conditions, anxiety, insomnia, and palliative symptoms—when conventional licensed treatments have not provided sufficient relief.'],
  ['What do CBPMs look like?', 'Depending on your individual clinical prescription, products can include dried flower for vaporisation, sublingual oils, or inhalation cartridges. Your clinical team and dispensing pharmacist explain exactly how the prescribed medicine should be used.'],
  ['Will CBPMs get me high?', 'Treatment is prescribed and carefully monitored to achieve therapeutic clinical benefit. THC can affect alertness or cause intoxication, which is why dosing, titration and specialist medical guidance are strictly observed.'],
  ['What is the difference between CBD and THC?', 'CBD and THC are two primary cannabinoids with distinct physiological effects. THC is psychoactive; CBD is non-intoxicating. Prescription products may contain formulated ratios of one or both, tailored by your specialist doctor.'],
  ['What’s the difference between CBD products and CBPMs?', 'Over-the-counter CBD wellness products sold on the high street are not the same as prescription cannabis-based medicines, which require formal clinical oversight, pharmaceutical GMP quality certification, and tailored clinical dosing.'],
  ['What does EU GMP medical cannabis mean?', 'EU GMP (Good Manufacturing Practice) refers to stringent European pharmaceutical manufacturing standards designed to guarantee consistent quality, purity, and controlled production without contaminants.'],
  ['What is a Summary Care Record (SCR)?', 'A Summary Care Record contains key information from your GP medical record (including current medicines, allergies, and health history). With your explicit consent, it allows the assessing specialist clinician to review your treatment history safely.'],
  ['How do I get a prescription for CBPMs?', 'A specialist doctor must assess you through a clinical consultation. If treatment is appropriate and approved by the multi-disciplinary team (MDT), the prescription is transmitted to your nominated pharmacy for dispensing.'],
  ['Am I eligible for CBPM therapy?', 'Eligibility generally requires that you have a diagnosed eligible condition and have previously tried at least two licensed therapies or medicines that proved ineffective or caused intolerable side effects. Complete the secure Holistic Health Hub eligibility pre-check to start a review.'],
] as const;


function SiteFooter() {
  return (
    <footer className="hhh-footer">
      <div className="hhh-footer__inner">
        <div className="hhh-footer__brand">
          <img src={MARK} alt="Holistic Health Hub" width="58" height="58" />
          <p>Personalised specialist healthcare, connecting patients with specialist doctors and trusted community pharmacies.</p>
          <div className="hhh-footer__badges">
            <span>ICO Registered ZB639206</span>
            <span>UK Medical Cannabis (CBPM)</span>
          </div>
          <small>© {new Date().getFullYear()} Holistic Health Hub, a trading name of Fit-Pharma Ltd (company no. 11950925), 124 City Road, London EC1V 2NX.</small>
        </div>
        <div>
          <strong>Care Journey</strong>
          <PublicLink href="/how-it-works">How it works</PublicLink>
          <PublicLink href="/conditions">Treatable conditions</PublicLink>
          <PublicLink href="/eligibility">Eligibility check</PublicLink>
          <a href="https://portal.holistichealthhub.live" rel="nofollow">Pharmacy portal</a>
        </div>
        <div>
          <strong>Company</strong>
          <PublicLink href="/about">About our mission</PublicLink>
          <PublicLink href="/blog">Health journal</PublicLink>
          <PublicLink href="/faq">Patient FAQs</PublicLink>
        </div>
        <div>
          <strong>Legal &amp; Trust</strong>
          <PublicLink href="/terms">Terms of Use</PublicLink>
          <PublicLink href="/privacy">Privacy Notice</PublicLink>
          <PublicLink href="/costs">Costs</PublicLink>
          <a href="mailto:info@holistichealthhub.live">info@holistichealthhub.live</a>
          <div className="hhh-social" aria-label="Social links">
            <a href="https://www.instagram.com/holistichealthhub1" target="_blank" rel="noopener noreferrer" aria-label="Instagram">
              <span>ig</span>
            </a>
            <a href="https://www.facebook.com/profile.php?id=61555967331192" target="_blank" rel="noopener noreferrer" aria-label="Facebook">
              <span>f</span>
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}

function useAtmosphereParallax(
  layerRef: { current: HTMLDivElement | null },
  mode: 'page' | 'local',
) {
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let frame = 0;
    const update = () => {
      frame = 0;
      if (mode === 'page') {
        const travel = Math.max(document.documentElement.scrollHeight - window.innerHeight, 1);
        const progress = Math.min(1, Math.max(0, window.scrollY / travel));
        layer.style.setProperty('--hhh-parallax', progress.toFixed(3));
        return;
      }
      const host = layer.parentElement;
      if (!host) return;
      const rect = host.getBoundingClientRect();
      const progress = Math.min(1.15, Math.max(-0.15, -rect.top / Math.max(rect.height, 1)));
      layer.style.setProperty('--hhh-parallax', progress.toFixed(3));
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };

    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [mode]);
}

function PageAtmosphere() {
  const layerRef = useRef<HTMLDivElement>(null);
  useAtmosphereParallax(layerRef, 'page');

  return (
    <div className="hhh-atmosphere hhh-atmosphere--page" ref={layerRef} aria-hidden="true">
      <span className="hhh-float hhh-float--orb hhh-float--a"><span /></span>
      <span className="hhh-float hhh-float--ring hhh-float--b"><span /></span>
      <span className="hhh-float hhh-float--orb hhh-float--c"><span /></span>
      <span className="hhh-float hhh-float--ring hhh-float--d"><span /></span>
      <span className="hhh-float hhh-float--dot hhh-float--e"><span /></span>
    </div>
  );
}

function LocalAtmosphere() {
  const layerRef = useRef<HTMLDivElement>(null);
  useAtmosphereParallax(layerRef, 'local');

  return (
    <div className="hhh-atmosphere hhh-atmosphere--local" ref={layerRef} aria-hidden="true">
      <span className="hhh-float hhh-float--orb hhh-float--local-a"><span /></span>
      <span className="hhh-float hhh-float--ring hhh-float--local-b"><span /></span>
    </div>
  );
}

function PageShell({ children }: { children: ReactNode }) {
  const { pathname } = usePublicLocation();

  useEffect(() => {
    const sections = document.querySelectorAll<HTMLElement>('#main-content > *');
    sections.forEach((section, index) => {
      section.style.setProperty('--enter-i', String(index));
    });
    document.body.style.setProperty('--page-beats', String(Math.max(sections.length - 1, 0)));
    return () => {
      document.body.style.removeProperty('--page-beats');
    };
  }, [pathname]);

  return (
    <div className="hhh-public">
      <PageAtmosphere />
      <a className="hhh-skip" href="#main-content">Skip to main content</a>
      <PublicHeader />
      {children}
      <SiteFooter />
    </div>
  );
}

/**
 * Sticky Chapter Scroller for the 4-step process story.
 * The media column pins on desktop while steps 01-04 scroll alongside, crossfading photos cleanly.
 */
function StickyStepNarrative() {
  const [activeStep, setActiveStep] = useState(0);
  const stepRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const observer = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            const index = Number(entry.target.getAttribute('data-step-index'));
            if (!Number.isNaN(index)) {
              setActiveStep(index);
            }
          }
        });
      },
      { rootMargin: '-25% 0px -45% 0px', threshold: 0.2 }
    );

    stepRefs.current.forEach(ref => {
      if (ref) observer.observe(ref);
    });

    return () => observer.disconnect();
  }, []);

  return (
    <section className="hhh-sticky-chapter" aria-label="Step by step care journey">
      <div className="hhh-section-inner hhh-sticky-chapter__inner">
        <div className="hhh-sticky-chapter__pinned" aria-hidden="true">
          <div className="hhh-sticky-chapter__frame">
            {steps.map((step, idx) => (
              <img
                key={step.number}
                src={step.image}
                alt=""
                className={`hhh-sticky-chapter__image ${idx === activeStep ? 'is-active' : ''}`}
                loading={idx === 0 ? 'eager' : 'lazy'}
              />
            ))}
            <div className="hhh-sticky-chapter__badge">
              <span className="hhh-sticky-chapter__badge-number">Step {steps[activeStep].number}</span>
              <span className="hhh-sticky-chapter__badge-title">{steps[activeStep].title}</span>
            </div>
            <div className="hhh-sticky-chapter__arc" />
          </div>
        </div>

        <div className="hhh-sticky-chapter__rail">
          <div className="hhh-sticky-chapter__spine" aria-hidden="true">
            <div
              className="hhh-sticky-chapter__spine-fill"
              style={{ height: `${((activeStep + 1) / steps.length) * 100}%` }}
            />
          </div>

          <div className="hhh-sticky-chapter__steps">
            {steps.map((step, idx) => (
              <article
                key={step.number}
                ref={el => { stepRefs.current[idx] = el; }}
                data-step-index={idx}
                className={`hhh-sticky-chapter__step ${idx === activeStep ? 'is-active' : ''}`}
              >
                <div className="hhh-sticky-chapter__step-mobile-media">
                  <img src={step.image} alt={step.imageAlt} loading="lazy" />
                  <span className="hhh-sticky-chapter__step-num">{step.number}</span>
                </div>

                <div className="hhh-sticky-chapter__step-header">
                  <span className="hhh-kicker">{step.kicker}</span>
                  <span className="hhh-sticky-chapter__tag">{step.tag}</span>
                </div>

                <h2>{step.number}. {step.title}</h2>
                <p>{step.copy}</p>

                {(idx === 1 || idx === 2 || idx === 3) && (
                  <div className="hhh-sticky-chapter__step-footer">
                    {idx === 1 && (
                      <span className="hhh-inline-note">
                        <Stethoscope aria-hidden="true" /> Dedicated GMC-registered specialist assessment
                      </span>
                    )}
                    {idx === 2 && (
                      <span className="hhh-inline-note">
                        <PackageCheck aria-hidden="true" /> GPhC registered pharmacy dispensing
                      </span>
                    )}
                    {idx === 3 && (
                      <PublicLink href="/eligibility" className="hhh-text-link">
                        Check eligibility <ChevronRight aria-hidden="true" />
                      </PublicLink>
                    )}
                  </div>
                )}
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function HomePage() {
  return (
    <PageShell>
      <main id="main-content">
        {/* Cinematic Hero */}
        <section className="hhh-hero">
          <div className="hhh-section-inner hhh-hero__inner">
            <div className="hhh-hero__copy hhh-rise-copy">
              <p className="hhh-kicker">Personalised specialist healthcare · UK</p>
              <h1>Feel heard.<br />Find a way forward.</h1>
              <p className="hhh-hero__lede">
                Access specialist therapies, including medical cannabis (CBPM) treatment programmes, through Holistic Health Hub and our network of trusted partnered pharmacies and specialist clinic.
              </p>
              <div className="hhh-hero__actions">
                <PublicLink href="/eligibility" className="hhh-button hhh-button--rust">
                  Check your eligibility <ArrowRight aria-hidden="true" />
                </PublicLink>
                <PublicLink href="/how-it-works" className="hhh-text-link">
                  See how it works <ChevronRight aria-hidden="true" />
                </PublicLink>
              </div>
              <div className="hhh-hero__assurance">
                <span><ShieldCheck aria-hidden="true" /> Private and secure</span>
                <span><Stethoscope aria-hidden="true" /> Specialist-led</span>
                <span><HeartHandshake aria-hidden="true" /> Pharmacy connected</span>
              </div>
            </div>

            <div className="hhh-hero__media">
              <div className="hhh-hero__frame">
                <img
                  src={HERO_IMAGE}
                  alt="A consultant clinician listening attentively to a patient in a private clinic consultation room"
                  fetchPriority="high"
                  width="720"
                  height="570"
                />
              </div>
              <div className="hhh-hero__tag-badge">
                <span><HeartPulse aria-hidden="true" /></span>
                <div>
                  <strong>Care built around you</strong>
                  <small>From first questions to ongoing support</small>
                </div>
              </div>
              <div className="hhh-hero__arc-motif" aria-hidden="true" />
            </div>
          </div>
        </section>

        {/* Section flow transition */}
        <div className="hhh-motif-divider" aria-hidden="true">
          <div className="hhh-motif-divider__line" />
          <div className="hhh-motif-divider__orbit"><Orbit /></div>
        </div>

        {/* 4-Step Journey Narrative */}
        <section className="hhh-journey hhh-reveal-block">
          <div className="hhh-section-inner">
            <div className="hhh-journey__header">
              <div>
                <p className="hhh-kicker">A clear route to care</p>
                <h2>How it works in four simple steps</h2>
              </div>
              <PublicLink href="/how-it-works" className="hhh-button hhh-button--outline">
                Explore the full journey <ArrowRight aria-hidden="true" />
              </PublicLink>
            </div>

            <div className="hhh-journey__grid">
              {steps.map((step, index) => (
                <article key={step.number} style={{ '--stagger-index': index } as CSSProperties}>
                  <figure className="hhh-journey__figure">
                    <img src={step.image} alt={step.imageAlt} loading="lazy" />
                    <figcaption>{step.number}</figcaption>
                  </figure>
                  <div className="hhh-journey__body">
                    <span className="hhh-journey__step-tag">{step.kicker}</span>
                    <h3>{step.title}</h3>
                    <p>{step.copy}</p>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* Clinical Network Architecture */}
        <section className="hhh-network hhh-reveal-block">
          <div className="hhh-section-inner">
            <div className="hhh-network__intro">
              <p className="hhh-kicker">Who supports you</p>
              <h2>Holistic Health Hub, a specialist clinic and your pharmacy, working together.</h2>
              <p className="hhh-network__lede">
                Care is delivered through distinct, regulated roles ensuring patient privacy, independent clinical assessment, and safe dispensing.
              </p>
            </div>

            <div className="hhh-network__cards">
              {[
                {
                  number: '01',
                  role: 'Intake & Referral',
                  title: 'Holistic Health Hub',
                  copy: 'Reviews your initial eligibility, answers pre-screening questions, stays with you through intake, and confirms the referral destination.',
                  icon: <ShieldCheck aria-hidden="true" />,
                },
                {
                  number: '02',
                  role: 'Clinical Assessment',
                  title: 'Specialist clinic',
                  copy: 'A GMC-registered doctor who specialises in your condition assesses you. Treatment decisions are clinical, made with an MDT, and never automatic.',
                  icon: <Stethoscope aria-hidden="true" />,
                },
                {
                  number: '03',
                  role: 'Dispensing & Care',
                  title: 'Nominated pharmacy',
                  copy: 'Arranges payment, pharmaceutical dispensing, and reliable delivery or collection once an appropriate prescription is issued.',
                  icon: <PackageCheck aria-hidden="true" />,
                },
              ].map((item, index) => (
                <article key={item.title} style={{ '--stagger-index': index } as CSSProperties}>
                  <div className="hhh-network__card-top">
                    <span className="hhh-network__num">{item.number}</span>
                    <span className="hhh-network__icon">{item.icon}</span>
                  </div>
                  <span className="hhh-network__role">{item.role}</span>
                  <h3>{item.title}</h3>
                  <p>{item.copy}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* Value Highlights */}
        <section className="hhh-benefits hhh-section-inner hhh-reveal-block" aria-label="Key patient benefits">
          {[
            { icon: <Globe2 aria-hidden="true" />, text: 'Online appointments that suit you' },
            { icon: <Clock3 aria-hidden="true" />, text: 'Personalised treatment options' },
            { icon: <Video aria-hidden="true" />, text: 'No GP referral required' },
            { icon: <UserRoundCheck aria-hidden="true" />, text: 'Access to specialist medical professionals' },
            { icon: <HeartHandshake aria-hidden="true" />, text: 'Dedicated patient support' },
          ].map((item, index) => (
            <div key={item.text} style={{ '--stagger-index': index } as CSSProperties}>
              <span>{item.icon}</span>
              <p>{item.text}</p>
            </div>
          ))}
        </section>

        {/* Condition Feature Showcase */}
        <section className="hhh-condition-feature hhh-reveal-block">
          <div className="hhh-section-inner">
            <div className="hhh-condition-feature__top">
              <div>
                <p className="hhh-kicker">Conditions we support</p>
                <h2>Some of the conditions<br />we can help you with</h2>
              </div>
              <PublicLink className="hhh-button hhh-button--outline" href="/conditions">
                Which conditions can be treated? <ArrowRight aria-hidden="true" />
              </PublicLink>
            </div>

            <div className="hhh-condition-card">
              <div className="hhh-condition-card__intro">
                <span><Activity aria-hidden="true" /></span>
                <span className="hhh-condition-card__category">Primary Focus</span>
                <h3>Pain</h3>
                <p>
                  For many of the 28 million people in the UK living with chronic pain, traditional painkillers like opioids aren’t always the answer. Holistic therapies such as medical cannabis offer alternative options.
                </p>
                <div className="hhh-condition-card__kpis">
                  <div><strong>28M+</strong><small>UK adults with chronic pain</small></div>
                  <div><strong>MDT</strong><small>Specialist team review</small></div>
                </div>
              </div>
              <div className="hhh-condition-card__body">
                <h4>How medical cannabis can help with pain</h4>
                <p>
                  Everybody has an endocannabinoid system (ECS) which plays a significant role in regulating pain, inflammation and other vital functions. Medical cannabis, which contains phytocannabinoids like THC and CBD, influences how the body responds to pain signals.
                </p>
                <p className="hhh-condition-card__note">Pain-related conditions we can help you treat:</p>
                <div className="hhh-tag-list">
                  {[
                    'Arthritis', 'Back Pain', 'Chronic Pain', 'Cluster Headache',
                    'Complex Regional Pain Syndrome', 'Cancer-Related Pain', 'Ehlers-Danlos Syndromes (EDS)',
                    'Endometriosis', 'Fibromyalgia', 'Musculoskeletal Pain', 'Migraine',
                    'Neuropathic Pain', 'Palliative Care', 'Sciatica',
                  ].map(tag => (
                    <span key={tag}>{tag}</span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="hhh-key-benefits hhh-section-inner hhh-reveal-block" aria-label="Why patients choose specialist referral">
          <div className="hhh-key-benefits__top">
            <p className="hhh-kicker">Why patients choose Holistic Health Hub</p>
            <h2>Specialist care, without another generic appointment.</h2>
          </div>
          <div className="hhh-key-benefits__list">
            {[
              {
                number: '01',
                role: 'Specialist assessment',
                icon: <Stethoscope aria-hidden="true" />,
                title: 'A specialist in your condition',
                copy: 'You see a GMC-registered doctor who specialises in the condition you need help with, not a general appointment.',
              },
              {
                number: '02',
                role: 'Treatment history',
                icon: <Leaf aria-hidden="true" />,
                title: 'When standard treatment has not been enough',
                copy: 'If two licensed therapies have not given sufficient relief, a specialist can consider whether a cannabis-based medicine is clinically appropriate.',
              },
              {
                number: '03',
                role: 'Clinical review',
                icon: <ShieldCheck aria-hidden="true" />,
                title: 'Reviewed by a clinical team',
                copy: 'Treatment is never automatic. A multi-disciplinary team of doctors and pharmacists reviews whether a plan is right for you.',
              },
            ].map((item, index) => (
              <article key={item.title} style={{ '--stagger-index': index } as CSSProperties}>
                <div className="hhh-network__card-top">
                  <span className="hhh-network__num">{item.number}</span>
                  <span className="hhh-network__icon">{item.icon}</span>
                </div>
                <span className="hhh-network__role">{item.role}</span>
                <h3>{item.title}</h3>
                <p>{item.copy}</p>
              </article>
            ))}
          </div>
        </section>

        {/* Patient Testimonials */}
        <section className="hhh-testimonials hhh-reveal-block" aria-label="Patient feedback">
          <div className="hhh-section-inner">
            <div className="hhh-testimonials__header">
              <p className="hhh-kicker">Patient testimonials</p>
              <h2>Experiences from our patient community</h2>
            </div>
            <div className="hhh-testimonials__grid">
              {[
                ['“I felt that I was listened to, and the different types of pain I was experiencing was understood and my treatment plan was tailored to suit my individual needs.”', 'Keasha', 'Chronic pain patient'],
                ['“It wasn’t until I saw my consultant that I felt properly listened to for the first time in years. The service I’ve received is second to none.”', 'Xavier', 'Specialist clinic patient'],
                ['“Life with social anxiety and insomnia is horrendous. But my experience at the clinic has been amazing, they have been very understanding, a life saver.”', 'Kim', 'Anxiety & sleep patient'],
              ].map(([quote, name, role]) => (
                <blockquote key={name}>
                  <p>{quote}</p>
                  <footer>
                    <cite><strong>{name}</strong><small>{role}</small></cite>
                  </footer>
                </blockquote>
              ))}
            </div>
          </div>
        </section>

        {/* Press Wordmarks */}
        <section className="hhh-press hhh-reveal-block" aria-label="Media coverage wordmarks">
          <div className="hhh-section-inner">
            <p className="hhh-kicker">As seen in UK media</p>
            <div className="hhh-press__wordmarks">
              <span>GOV.UK</span>
              <span>Sky News</span>
              <span>The Guardian</span>
            </div>
          </div>
        </section>

        {/* Trust & Responsibility Band */}
        <section className="hhh-trust-band hhh-reveal-block">
          <div className="hhh-section-inner">
            <span><ShieldCheck aria-hidden="true" /></span>
            <div>
              <p className="hhh-kicker">Thoughtful, responsible care</p>
              <h2>Private treatment should still feel personal.</h2>
              <p>Your eligibility check is only a starting point. A specialist clinician makes treatment decisions after an appropriate assessment, and your pharmacy remains part of the support around you.</p>
            </div>
            <PublicLink href="/about" className="hhh-button hhh-button--pale">Meet Holistic Health Hub</PublicLink>
          </div>
        </section>

        {/* Journal Teaser */}
        <section className="hhh-learn hhh-section-inner hhh-reveal-block">
          <div className="hhh-learn__header">
            <div>
              <p className="hhh-kicker">Learn &amp; Explore</p>
              <h2>From the Holistic Health Hub Journal</h2>
            </div>
            <PublicLink href="/blog" className="hhh-text-link">
              Read all articles <ArrowRight aria-hidden="true" />
            </PublicLink>
          </div>
          <div className="hhh-post-grid">
            {posts.slice(0, 3).map(post => <PostCard key={post.slug} post={post} />)}
          </div>
        </section>
      </main>
    </PageShell>
  );
}

function InnerPageHero({
  eyebrow,
  title,
  copy,
  children,
}: {
  eyebrow: string;
  title: ReactNode;
  copy: string;
  children?: ReactNode;
}) {
  return (
    <section className="hhh-page-head">
      <div className="hhh-section-inner hhh-rise-copy">
        <p className="hhh-kicker">{eyebrow}</p>
        <h1>{title}</h1>
        <p>{copy}</p>
        {children && <div className="hhh-page-head__actions">{children}</div>}
      </div>
    </section>
  );
}

function PageCta({ kicker, title, copy, href, label }: { kicker: string; title: string; copy: string; href: string; label: string }) {
  return (
    <section className="hhh-page-cta hhh-reveal-block">
      <div className="hhh-section-inner">
        <div>
          <p className="hhh-kicker">{kicker}</p>
          <h2>{title}</h2>
          <p>{copy}</p>
        </div>
        <PublicLink href={href} className="hhh-button hhh-button--pale">
          {label} <ArrowRight aria-hidden="true" />
        </PublicLink>
      </div>
    </section>
  );
}

function ConditionsPage() {
  return (
    <PageShell>
      <main id="main-content">
        <InnerPageHero
          eyebrow="Conditions we support"
          title={<>Conditions that can be treated<br />with medical cannabis (CBPM)</>}
          copy="If you have tried two therapies or treatments for these conditions that have not provided sufficient benefit, you may be eligible for referral. A specialist clinician assesses you and decides whether treatment is appropriate."
        >
          <PublicLink href="/how-it-works" className="hhh-text-link">
            See how it works <ChevronRight aria-hidden="true" />
          </PublicLink>
        </InnerPageHero>

        <section className="hhh-about-story">
          <div className="hhh-section-inner hhh-about-story__inner">
            <figure className="hhh-about-story__media">
              <img
                src={ELIGIBILITY_IMAGE}
                alt="A patient privately completing a confidential eligibility pre-check at home"
                width="720"
                height="900"
              />
              <figcaption>
                <strong>Private eligibility review</strong>
                <small>Your application stays with Holistic Health Hub first</small>
              </figcaption>
            </figure>
            <div className="hhh-about-story__copy">
              <p className="hhh-kicker">Before a referral</p>
              <h2>Treatment is never automatic.</h2>
              <p>
                Holistic Health Hub reviews your eligibility first. A GMC-registered doctor who specialises in your condition then decides whether a cannabis-based medicine is clinically appropriate.
              </p>
              <p>
                That decision is made with a multi-disciplinary team, and only after conventional treatment options have been explored.
              </p>
              <p className="hhh-about-story__note">
                The lists below are examples of conditions that may be considered. They are not a diagnosis, and they are not a promise of a prescription.
              </p>
              <div className="hhh-about-copy__actions">
                <PublicLink href="/how-it-works" className="hhh-button hhh-button--outline">See how it works</PublicLink>
                <PublicLink href="/about" className="hhh-text-link">
                  Meet Holistic Health Hub <ChevronRight aria-hidden="true" />
                </PublicLink>
              </div>
            </div>
          </div>
        </section>

        <section className="hhh-about-role" aria-label="How conditions are assessed">
          <div className="hhh-section-inner">
            <div className="hhh-about-role__intro">
              <p className="hhh-kicker">How you are assessed</p>
              <h2>Three steps before a prescription can be considered.</h2>
              <p>
                These are the clinical gates. A referral is not automatic, and it is not a diagnosis. Every patient goes through the same review.
              </p>
            </div>
            <div className="hhh-about-role__cards">
              {[
                {
                  number: '01',
                  role: 'Step one',
                  icon: <ClipboardCheck aria-hidden="true" />,
                  title: 'Two treatments tried',
                  copy: 'You may be eligible if two therapies or treatments for your condition have not provided sufficient benefit.',
                },
                {
                  number: '02',
                  role: 'Step two',
                  icon: <Stethoscope aria-hidden="true" />,
                  title: 'Specialist assessment',
                  copy: 'A consultant physician on the GMC Specialist Register assesses you in relation to your specific condition.',
                },
                {
                  number: '03',
                  role: 'Step three',
                  icon: <ShieldCheck aria-hidden="true" />,
                  title: 'MDT review',
                  copy: 'A multi-disciplinary team of doctors and pharmacists reviews whether a CBPM is clinically appropriate for you.',
                },
              ].map((item, index) => (
                <article key={item.title} style={{ '--stagger-index': index } as CSSProperties}>
                  <div className="hhh-network__card-top">
                    <span className="hhh-network__num">{item.number}</span>
                    <span className="hhh-network__icon">{item.icon}</span>
                  </div>
                  <span className="hhh-network__role">{item.role}</span>
                  <h3>{item.title}</h3>
                  <p>{item.copy}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="hhh-condition-groups hhh-section-inner">
          {conditionGroups.map((group, index) => (
            <article key={group.title} style={{ '--stagger-index': index } as CSSProperties}>
              <figure className="hhh-condition-group__media">
                <img
                  src={group.image}
                  alt={group.imageAlt}
                  loading="lazy"
                  style={{ objectPosition: group.imagePosition }}
                />
                <figcaption className="hhh-condition-group__head">
                  <span>{group.icon}</span>
                  <h2>{group.title}</h2>
                </figcaption>
              </figure>
              <p className="hhh-condition-group__lead">{group.lead}</p>
              <ul>
                {group.items.map(item => (
                  <li key={item}>
                    <Check aria-hidden="true" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </section>

        <PageCta
          kicker="Next question"
          title="Ready to see whether you may be eligible?"
          copy="Consultation and medicine fees are discussed at your first specialist appointment, and confirmed before you proceed."
          href="/eligibility"
          label="Check eligibility"
        />
      </main>
    </PageShell>
  );
}

function formatEcologiNumber(value: number) {
  return new Intl.NumberFormat('en-GB', {
    maximumFractionDigits: Number.isInteger(value) ? 0 : 1,
  }).format(value);
}

function EcologiImpactCard() {
  const [trees, setTrees] = useState(ECOLOGI_TREES_FALLBACK);
  const [extras, setExtras] = useState<{ value: number; label: string }[]>([]);

  useEffect(() => {
    let cancelled = false;

    fetch(ECOLOGI_IMPACT_URL)
      .then(response => (response.ok ? response.json() : Promise.reject(new Error('Ecologi impact unavailable'))))
      .then(data => {
        if (cancelled || typeof data?.trees !== 'number') return;
        setTrees(data.trees);
        setExtras([
          data.carbonOffset > 0 ? { value: data.carbonOffset, label: 'tonnes CO₂e avoided' } : null,
          data.carbonRemoval > 0 ? { value: data.carbonRemoval, label: 'tonnes CO₂e removed' } : null,
          data.habitatRestoration > 0 ? { value: data.habitatRestoration, label: 'm² habitat restored' } : null,
        ].filter((item): item is { value: number; label: string } => item !== null));
      })
      .catch(() => {
        if (!cancelled) setTrees(ECOLOGI_TREES_FALLBACK);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <aside className="hhh-planet__proof">
      <p className="hhh-planet__proof-kicker">With Ecologi</p>
      <strong className="hhh-planet__stat">{formatEcologiNumber(trees)}</strong>
      <span className="hhh-planet__stat-label">{trees === 1 ? 'tree funded' : 'trees funded'}</span>
      {extras.length > 0 && (
        <ul className="hhh-planet__extras">
          {extras.map(item => (
            <li key={item.label}>
              <b>{formatEcologiNumber(item.value)}</b> {item.label}
            </li>
          ))}
        </ul>
      )}
      <div className="hhh-planet__actions">
        <a
          className="hhh-button hhh-button--pale"
          href={ECOLOGI_FUND_HREF}
          target="_blank"
          rel="noopener noreferrer"
        >
          Plant trees with Ecologi <ArrowRight aria-hidden="true" />
        </a>
        <a className="hhh-planet__profile" href={ECOLOGI_PROFILE_HREF} target="_blank" rel="noopener noreferrer">
          View our forest
        </a>
      </div>
    </aside>
  );
}

function AboutPage() {
  return (
    <PageShell>
      <main id="main-content">
        <InnerPageHero
          eyebrow="Our purpose"
          title={<>Get back to doing the things<br />you enjoy most.</>}
          copy="Holistic Health Hub is the referral hub between you, a specialist clinic, and a trusted community pharmacy."
        />

        <section className="hhh-about-story">
          <div className="hhh-section-inner hhh-about-story__inner">
            <figure className="hhh-about-story__media">
              <img
                src={WELLBEING_IMAGE}
                alt="A couple walking together through a garden, arm in arm"
                width="720"
                height="900"
              />
              <figcaption>
                <strong>Ordinary life, properly supported</strong>
                <small>The reason care should feel personal</small>
              </figcaption>
            </figure>
            <div className="hhh-about-story__copy">
              <p className="hhh-kicker">Why Holistic Health Hub exists</p>
              <h2>Plant-based options, with the right people around you.</h2>
              <p>
                Our mission is to provide holistic plant-based treatment options to those in need. Your team can include specialist <strong>doctors</strong>, clinical <strong>pharmacists</strong> and <strong>nurses</strong>, all committed to providing personalised care to each patient.
              </p>
              <p>
                They understand that every patient is unique, and will work closely with you to develop a medical cannabis treatment plan that is tailored to your specific needs, where that is clinically appropriate.
              </p>
              <p className="hhh-about-story__note">
                Holistic Health Hub reviews eligibility and stays with you through intake. A specialist clinician makes treatment decisions. Your nominated pharmacy supports dispensing once the referral is ready.
              </p>
              <div className="hhh-about-copy__actions">
                <PublicLink href="/conditions" className="hhh-button hhh-button--outline">Explore conditions</PublicLink>
                <PublicLink href="/how-it-works" className="hhh-button hhh-button--outline">See how it works</PublicLink>
              </div>
            </div>
          </div>
        </section>

        <section className="hhh-about-role" aria-label="How Holistic Health Hub fits">
          <div className="hhh-section-inner">
            <div className="hhh-about-role__intro">
              <p className="hhh-kicker">How we fit</p>
              <h2>Three roles, each with a clear job.</h2>
              <p>
                Holistic Health Hub is the referral hub, not the prescribing clinic. Treatment decisions stay with the specialist and the clinical team.
              </p>
            </div>
            <div className="hhh-about-role__cards">
              {[
                {
                  number: '01',
                  role: 'Intake & referral',
                  icon: <ShieldCheck aria-hidden="true" />,
                  title: 'Referral hub',
                  copy: 'Holistic Health Hub is not the prescribing clinic. We review eligibility, answer pre-screening questions, and confirm where your referral should go.',
                },
                {
                  number: '02',
                  role: 'Clinical assessment',
                  icon: <Stethoscope aria-hidden="true" />,
                  title: 'Specialist clinic',
                  copy: 'A GMC-registered doctor who specialises in your condition assesses you. Treatment decisions are clinical, made with an MDT, and never automatic.',
                },
                {
                  number: '03',
                  role: 'Dispensing & care',
                  icon: <PackageCheck aria-hidden="true" />,
                  title: 'Nominated pharmacy',
                  copy: 'Your community pharmacy supports payment, dispensing, and delivery or collection once an appropriate prescription is issued.',
                },
              ].map((item, index) => (
                <article key={item.title} style={{ '--stagger-index': index } as CSSProperties}>
                  <div className="hhh-network__card-top">
                    <span className="hhh-network__num">{item.number}</span>
                    <span className="hhh-network__icon">{item.icon}</span>
                  </div>
                  <span className="hhh-network__role">{item.role}</span>
                  <h3>{item.title}</h3>
                  <p>{item.copy}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="hhh-team">
          <div className="hhh-section-inner">
            <p className="hhh-kicker">Your care team</p>
            <h2>Specialists, pharmacists and nurses, working around you.</h2>
            <div className="hhh-team__grid">
              {[
                {
                  image: TEAM_SPECIALIST_IMAGE,
                  imageAlt: 'A specialist doctor in a calm clinic, ready to listen during a consultation',
                  title: 'Specialist doctors',
                  copy: 'A GMC-registered doctor who specialises in your condition assesses your history and decides whether a prescription is clinically appropriate.',
                },
                {
                  image: TEAM_PHARMACIST_IMAGE,
                  imageAlt: 'A community pharmacist checking a medicine before dispensing',
                  title: 'Clinical pharmacists',
                  copy: 'Your nominated community pharmacy supports dispensing, medicines reviews, and convenient delivery or pharmacy collection.',
                },
                {
                  image: TEAM_NURSE_IMAGE,
                  imageAlt: 'A nurse and patient-support coordinator listening during a follow-up conversation',
                  title: 'Nurses & patient support',
                  copy: 'Personalised follow-up sits alongside the clinic and pharmacy, so care and communication do not stop after the first appointment.',
                },
              ].map((item, index) => (
                <article key={item.title} style={{ '--stagger-index': index } as CSSProperties}>
                  <figure>
                    <img src={item.image} alt={item.imageAlt} loading="lazy" />
                  </figure>
                  <div>
                    <h3>{item.title}</h3>
                    <p>{item.copy}</p>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="hhh-planet">
          <div className="hhh-section-inner">
            <div className="hhh-planet__copy">
              <p className="hhh-kicker">Our commitment to the planet</p>
              <h2>Care that looks beyond today.</h2>
              <p className="hhh-planet__lede">
                We believe it is our collective duty to preserve the planet and the various forms of life that live on it.
              </p>
              <p>Future generations deserve a greener planet with better air quality.</p>
              <p>Cannabis itself is a carbon sequester, meaning it takes in more CO2 than it produces. That is not enough on its own, so for every CBPM prescription dispensed at a participating pharmacy, we support tree planting through Ecologi.</p>
            </div>
            <EcologiImpactCard />
          </div>
        </section>
      </main>
    </PageShell>
  );
}

function HowItWorksPage() {
  return (
    <PageShell>
      <main id="main-content">
        <InnerPageHero
          eyebrow="A supported route to care"
          title={<>From first questions<br />to ongoing support.</>}
          copy="Holistic Health Hub stays at the centre of your intake and referral. A specialist clinic assesses you, and a pharmacy receives your record only when the referral is ready."
        >
          <PublicLink href="/eligibility" className="hhh-text-link">
            Check eligibility <ChevronRight aria-hidden="true" />
          </PublicLink>
        </InnerPageHero>

        {/* Sticky Chapter Pin-and-Scrub Experience */}
        <StickyStepNarrative />

        {/* Data Protection Separation Band */}
        <section className="hhh-visibility-band hhh-reveal-block">
          <div className="hhh-section-inner">
            <div className="hhh-visibility-col">
              <span className="hhh-kicker">Before Holistic Health Hub refers you</span>
              <h2>Your application stays with Holistic Health Hub.</h2>
              <p>Holistic Health Hub reviews your eligibility, checks your treatment history, and confirms the referral destination with you. A community pharmacy does not review unverified eligibility applications.</p>
            </div>
            <div className="hhh-visibility-col hhh-visibility-col--dark">
              <span className="hhh-kicker">After Holistic Health Hub confirms</span>
              <h2>Your pharmacy record is activated.</h2>
              <p>The confirmed pharmacy can then support the operational parts of your care, including prescription management, dispensing, payment, and delivery or collection.</p>
            </div>
          </div>
        </section>

        {/* Next Step Security Card */}
        <section className="hhh-how-next hhh-section-inner hhh-reveal-block">
          <span><ShieldCheck aria-hidden="true" /></span>
          <div>
            <p className="hhh-kicker">Private by design</p>
            <h2>Ready to see whether you may be eligible?</h2>
            <p>The secure form keeps your health information out of emails, page URLs and browser storage.</p>
          </div>
          <PublicLink href="/eligibility" className="hhh-button hhh-button--rust">
            Begin securely <ArrowRight aria-hidden="true" />
          </PublicLink>
        </section>
      </main>
    </PageShell>
  );
}

function FaqAccordion() {
  const [openIndex, setOpenIndex] = useState(0);

  return (
    <div className="hhh-faq__list" role="region" aria-label="Frequently asked questions">
      {faqs.map(([question, answer], index) => {
        const isOpen = openIndex === index;
        const panelId = `faq-panel-${index}`;
        const buttonId = `faq-button-${index}`;

        return (
          <div key={question} className={`hhh-faq__item${isOpen ? ' is-open' : ''}`}>
            <h3>
              <button
                id={buttonId}
                type="button"
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => setOpenIndex(isOpen ? -1 : index)}
              >
                <span>{question}</span>
                <span className="hhh-faq__plus" aria-hidden="true">
                  <ChevronDown />
                </span>
              </button>
            </h3>
            <div
              id={panelId}
              className="hhh-faq__panel"
              aria-hidden={!isOpen}
            >
              <div className="hhh-faq__panel-inner">
                <p>{answer}</p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function FaqPage() {
  return (
    <PageShell>
      <main id="main-content">
        <InnerPageHero
          eyebrow="Questions, clearly answered"
          title={<>Understand your options<br />before you begin.</>}
          copy="Straightforward information about eligibility, cannabis-based medicines, clinical assessment, and what to expect from specialist care."
        />

        <section className="hhh-faq hhh-section-inner">
          <aside className="hhh-faq__intro">
            <LocalAtmosphere />
            <span><Sparkles aria-hidden="true" /></span>
            <p className="hhh-kicker">Frequently asked</p>
            <h2>Start with the essentials.</h2>
            <p>These answers are general information, not medical advice. A specialist clinician makes individual treatment decisions.</p>
          </aside>

          <FaqAccordion />
        </section>

        <PageCta
          kicker="Ready when you are"
          title="Take the first step securely."
          copy="Your eligibility application is reviewed by Holistic Health Hub before any patient record is activated for a pharmacy."
          href="/eligibility"
          label="Start eligibility check"
        />
      </main>
    </PageShell>
  );
}

function PostArtwork({ post, large = false }: { post: typeof posts[number]; large?: boolean }) {
  const icons = {
    sleep: <MoonStar aria-hidden="true" />,
    anxiety: <Sparkles aria-hidden="true" />,
    pain: <HeartPulse aria-hidden="true" />,
    balance: <Orbit aria-hidden="true" />,
  } as const;

  return (
    <span className={`hhh-post-art hhh-post-art--${post.art} ${large ? 'is-large' : ''}`} aria-hidden="true">
      <span>{icons[post.art]}</span>
      <small>{post.category}</small>
    </span>
  );
}

function PostCard({ post }: { post: typeof posts[number] }) {
  return (
    <article className="hhh-post-card">
      <PublicLink href={`/post/${post.slug}`} className="hhh-post-card__image" tabIndex={-1} aria-hidden="true">
        <PostArtwork post={post} />
      </PublicLink>
      <div className="hhh-post-card__body">
        <p className="hhh-post-meta">{post.category} · {post.read}</p>
        <h2><PublicLink href={`/post/${post.slug}`}>{post.title}</PublicLink></h2>
        <p>{post.excerpt}</p>
        <PublicLink href={`/post/${post.slug}`} className="hhh-post-card__more">
          Read article <ArrowRight aria-hidden="true" />
        </PublicLink>
      </div>
    </article>
  );
}

function BlogPage() {
  const [featured, ...morePosts] = posts;

  return (
    <PageShell>
      <main id="main-content">
        <InnerPageHero
          eyebrow="The Holistic Health Hub journal"
          title={<>Ideas for feeling<br />more like yourself.</>}
          copy="Clear, considered reading on sleep, pain management, mental wellbeing, and cannabis-based medicines."
        />

        <section className="hhh-blog hhh-section-inner hhh-reveal-block">
          <article className="hhh-blog-feature">
            <PublicLink href={`/post/${featured.slug}`} className="hhh-blog-feature__art" tabIndex={-1} aria-hidden="true">
              <PostArtwork post={featured} />
            </PublicLink>
            <div className="hhh-blog-feature__body">
              <p className="hhh-post-meta">Featured · {featured.category} · {featured.read}</p>
              <h2><PublicLink href={`/post/${featured.slug}`}>{featured.title}</PublicLink></h2>
              <p>{featured.excerpt}</p>
              <PublicLink href={`/post/${featured.slug}`} className="hhh-button hhh-button--outline">
                Read featured article <ArrowRight aria-hidden="true" />
              </PublicLink>
            </div>
          </article>

          <div className="hhh-blog__heading">
            <div>
              <p className="hhh-kicker">More from the journal</p>
              <h2>Explore our latest articles</h2>
            </div>
            <span>{posts.length} articles</span>
          </div>

          <div className="hhh-post-grid hhh-post-grid--wide">
            {morePosts.map(post => <PostCard key={post.slug} post={post} />)}
          </div>
        </section>
      </main>
    </PageShell>
  );
}

function ArticlePage({ slug }: { slug: string }) {
  const post = posts.find(item => item.slug === slug);
  if (!post) return <NotFoundPage />;

  return (
    <PageShell>
      <main id="main-content">
        <article className="hhh-article hhh-section-inner">
          <PublicLink href="/blog" className="hhh-text-link">← Back to all journal articles</PublicLink>
          <div className="hhh-rise-copy hhh-page-head__intro">
          <p className="hhh-post-meta">{post.author} · {post.date} · {post.read}</p>
          <h1>{post.title}</h1>
          <p className="hhh-article__lead">{post.excerpt}</p>
          </div>
          <PostArtwork post={post} large />
          <div className="hhh-article__content">
            {post.body.map((block, index) => {
              if (block.type === 'h2') return <h2 key={index}>{block.text}</h2>;
              if (block.type === 'ul') {
                return (
                  <ul key={index}>
                    {block.items.map(item => <li key={item}>{item}</li>)}
                  </ul>
                );
              }
              if (block.type === 'ol') {
                return (
                  <ol key={index}>
                    {block.items.map(item => <li key={item}>{item}</li>)}
                  </ol>
                );
              }
              return <p key={index}>{block.text}</p>;
            })}
          </div>
          <aside className="hhh-article__disclaimer">
            <strong>Important Clinical Notice</strong>
            <p>This article provides general educational information and is not medical advice. Prescription decisions for cannabis-based medicinal products (CBPM) must be made by a specialist doctor on the GMC register following an individual clinical assessment.</p>
          </aside>
        </article>
      </main>
    </PageShell>
  );
}

/**
 * Parts 2 and 3 of the approved HHH developer pack, published verbatim. The
 * wording is legally operative — the pharmacy is the controller and HHH is its
 * processor — so edit these only from an updated approved pack, and bump both the
 * version line here and PRIVACY_NOTICE_VERSION in the intake router together.
 */
const LEGAL_LAST_UPDATED = '7 September 2026';
const LEGAL_VERSION = '1.0';

function LegalMeta() {
  return <p className="hhh-legal-meta">Last updated: {LEGAL_LAST_UPDATED} · Version: {LEGAL_VERSION}</p>;
}

function TermsPage() {
  return (
    <PageShell>
      <main id="main-content">
        <article className="hhh-legal hhh-section-inner">
          <div className="hhh-rise-copy hhh-page-head__intro">
            <p className="hhh-kicker">Terms of Use</p>
            <h1>Terms of Use — specialist referral service</h1>
            <LegalMeta />
          </div>

          <h2>1. Who provides this service</h2>
          <p>1.1 This referral service is provided by your pharmacy. In these terms, “we”, “us”, “our” and “your pharmacy” mean the partner pharmacy you select in the eligibility check. Your pharmacy is registered with the General Pharmaceutical Council; its name, address, GPhC premises number and contact details are shown when you select it and in every message we send you.</p>
          <p>1.2 We run the service through Holistic Health Hub (“HHH”). HHH’s pharmacists and pharmacy technicians, all registered with the General Pharmaceutical Council, work on our behalf: they review applications, contact you in our name when we ask them to, view your NHS record under our authority and make referrals to the clinic for us. Our own pharmacy team may also contact you directly at any stage. HHH also provides the software we use to manage prescriptions, collection and delivery. Holistic Health Hub is a trading name of Fit-Pharma Ltd (company number 11950925), 124 City Road, London EC1V 2NX.</p>
          <p>1.3 This website (holistichealthhub.live) is operated by HHH. Until you select a pharmacy, no application information is collected. Sections 2–12 apply to the service your pharmacy provides; section 13 applies to the website itself.</p>

          <h2>2. What the service is, and is not</h2>
          <p>2.1 We review whether a referral to our partner clinic is appropriate, help gather the health record the clinic needs, and if suitable refer you. If you are prescribed, we dispense your medicine for collection or, where we offer it, delivery.</p>
          <p>2.2 We do not diagnose or treat, and the referral service is not medical advice. Our partner clinic is regulated by the Care Quality Commission and is named in our <PublicLink href="/privacy">Privacy Notice</PublicLink>; its specialist doctors are on the GMC Specialist Register and make every decision about appointments and treatment.</p>

          <h2>3. Who can use the service</h2>
          <p>3.1 You must be 18 or over and living in the United Kingdom. Applications from anyone under 18 are deleted. Our partner pharmacies are in England: some offer collection only, some also deliver. Each pharmacy’s options are shown when you select it, so choose one you can collect from or that delivers to you.</p>
          <p>3.2 You must apply for yourself. We do not accept applications made on someone else’s behalf.</p>
          <p>3.3 If your GP practice is outside England, you will need to give us a copy of your GP record yourself (section 5.3).</p>

          <h2>4. Three separate decisions</h2>
          <p>4.1 The eligibility check decides only whether we will refer you. It is not a diagnosis and does not guarantee an appointment or a prescription.</p>
          <p>4.2 The clinic decides whether to offer you an appointment.</p>
          <p>4.3 The specialist decides, after assessing you, whether to prescribe. Any medicine prescribed may be unlicensed; the clinic will explain what that means.</p>
          <p>4.4 We refer to one partner clinic. You are free to arrange a consultation with any other clinic without using this service.</p>
          <p>4.5 Two answers on the form are checked automatically against the clinic’s criteria: whether you have tried at least two licensed treatments, and whether you or an immediate family member has been diagnosed with psychosis or schizophrenia. If either falls outside the criteria you are told immediately and we cannot refer you. You can ask one of our pharmacists to review that result by emailing <a href="mailto:info@holistichealthhub.live">info@holistichealthhub.live</a>.</p>

          <h2>5. What happens after you apply</h2>
          <p>5.1 <strong>Review and contact.</strong> A registered pharmacist or technician — from our own team or from the HHH team acting for us — reviews your application and may phone, email or text you. We aim to do this within 3 working days.</p>
          <p>5.2 <strong>Your pharmacy.</strong> You are applying to the pharmacy you select. If we cannot take you on — for example because of distance or capacity — we will offer, with your agreement, to pass your application to another partner pharmacy. Nothing is shared with any other pharmacy unless you agree.</p>
          <p>5.3 <strong>Your health record.</strong> The clinic needs a summary of your GP record before a specialist can see you. In England, with your permission, a registered pharmacy professional on the HHH team, acting for us, will view your NHS Summary Care Record and upload it to the clinic’s secure referral portal. Outside England, or if you prefer, you can supply a copy yourself (for example from the NHS App) and we will upload it in the same way. Your record is not stored on the HHH platform.</p>
          <p>5.4 <strong>Referral.</strong> If we decide to refer you, we send your application and record to the clinic and tell you we have done so. From then on the clinic is your contact for appointments and treatment.</p>
          <p>5.5 <strong>Prescriptions, collection and delivery.</strong> If you are prescribed, the clinic sends the prescription to us. We tell you the cost, take payment, order your medicine, and tell you when it is ready. You collect it from the pharmacy (bring photo ID) or, where we offer delivery, we send it by a tracked service that requires proof of identity and an adult signature on receipt. We tell you which applies, and any delivery charge, before you pay.</p>

          <h2>6. Costs</h2>
          <p>6.1 The eligibility check and referral are free.</p>
          <p>6.2 Consultations are private and are charged by the clinic. Medicine is private and is charged separately by us when you order it. Current clinic fees are shown at <PublicLink href="/costs">holistichealthhub.live/costs</PublicLink>. You will be told the applicable fees before you book, and the price of any medicine and any delivery charge before you pay.</p>

          <h2>7. Your responsibilities</h2>
          <p>7.1 Give accurate and complete information, and tell us if anything changes before your referral is made.</p>
          <p>7.2 Answer the screening questions truthfully. They exist for your safety; the specialist will ask them again.</p>
          <p>7.3 Do not use the form for anyone other than yourself, or in any way that is unlawful or interferes with the service.</p>

          <h2>8. Withdrawing</h2>
          <p>8.1 You can withdraw your application at any time before we refer you by contacting us (section 12). We will stop the process and delete your application within 3 months, keeping only a minimal record of the withdrawal.</p>
          <p>8.2 After referral, contact the clinic to cancel or change an appointment. Their cancellation terms apply.</p>

          <h2>9. How we contact you</h2>
          <p>9.1 We contact you by phone, email or text about your application — either directly from the pharmacy or through the HHH team acting for us — and again only when there is something you need to do or know. Service messages are not marketing and you cannot opt out of them while your application is open.</p>
          <p>9.2 Marketing emails or texts are sent only if you opted in, and you can unsubscribe at any time using the link or reply instructions in each message.</p>

          <h2>10. Your information</h2>
          <p>10.1 Our <PublicLink href="/privacy">Privacy Notice</PublicLink> explains what we collect, why, who we share it with, how long we keep it and your rights. It also explains that HHH processes your information on our behalf and under our instructions.</p>

          <h2>11. Our responsibility to you</h2>
          <p>11.1 We are responsible for providing the referral service, including the parts HHH carries out for us, with reasonable care and skill.</p>
          <p>11.2 We are not responsible for the clinic’s clinical decisions or for the accuracy of information the clinic gives you. Complaints about the clinic go to the clinic first (section 12).</p>
          <p>11.3 Nothing in these terms limits or excludes our liability for death or personal injury caused by our negligence, for fraud, or for anything else that cannot be limited by law.</p>
          <p>11.4 We are not liable for losses that were not foreseeable when you started using the service, or that are caused by your own breach of these terms.</p>

          <h2>12. Contact and complaints</h2>
          <p>12.1 <strong>About your application, your information or a complaint about the service:</strong> contact your pharmacy using the details shown when you selected it and in our messages to you. We acknowledge complaints within 3 working days and respond within 20 working days. Pharmacies are regulated by the General Pharmaceutical Council.</p>
          <p>12.2 <strong>About the clinic:</strong> use the clinic’s own complaints procedure (given to you at referral). The clinic is regulated by the Care Quality Commission.</p>
          <p>12.3 <strong>About how your information is handled:</strong> see the <PublicLink href="/privacy">Privacy Notice</PublicLink>; you can also contact the Information Commissioner’s Office.</p>

          <h2>13. This website</h2>
          <p>13.1 The website is operated by HHH (Fit-Pharma Ltd, details in 1.2). Contact: <a href="mailto:info@holistichealthhub.live">info@holistichealthhub.live</a>; complaints about the website: <a href="mailto:complaints@holistichealthhub.live">complaints@holistichealthhub.live</a>; privacy: <a href="mailto:privacy@holistichealthhub.live">privacy@holistichealthhub.live</a>.</p>
          <p>13.2 Content on the website is general information, not medical advice. It is not an emergency service: if you need urgent medical help, call 999 or 111. HHH may update the website and these terms; the date at the top shows the current version. Material changes that affect an open application will be emailed to you.</p>
          <p>13.3 HHH aims to keep the website available but does not guarantee it will be uninterrupted or error-free. Website content, design and branding belong to HHH or its licensors and may not be copied without permission; partner pharmacies use HHH’s materials under licence.</p>
          <p>13.4 These terms are governed by the law of England and Wales and any dispute will be dealt with by the courts of England and Wales. If you live in Scotland or Northern Ireland you may also bring proceedings in your local courts.</p>
          <p>13.5 If any part of these terms is found to be unenforceable, the rest continues to apply.</p>
        </article>
      </main>
    </PageShell>
  );
}

function PrivacyPage() {
  return (
    <PageShell>
      <main id="main-content">
        <article className="hhh-legal hhh-section-inner">
          <div className="hhh-rise-copy hhh-page-head__intro">
            <p className="hhh-kicker">Privacy Notice</p>
            <h1>Privacy Notice — specialist referral service</h1>
            <LegalMeta />
          </div>

          <h2>1. Who is responsible for your information</h2>
          <p>1.1 <strong>Your pharmacy</strong> — the partner pharmacy you select in the eligibility check — is responsible for your information (“controller”) for the referral service, from the moment you apply. In this notice “we”, “us” and “your pharmacy” mean that pharmacy. Its name, address, GPhC number, ICO registration number and privacy contact are shown when you select it and in every message we send you.</p>
          <p>1.2 <strong>Holistic Health Hub (“HHH”)</strong> runs the service for us and processes your information on our behalf and under our written instructions (“processor”). HHH’s GPhC-registered pharmacists and technicians act in our name when they review your application, contact you, view your NHS record and refer you. Our own pharmacy team may also contact you directly and sees your application through the same platform. Holistic Health Hub is a trading name of Fit-Pharma Ltd (company number 11950925), 124 City Road, London EC1V 2NX; ICO registration ZB639206; privacy contact <a href="mailto:privacy@holistichealthhub.live">privacy@holistichealthhub.live</a>.</p>
          <p>1.3 HHH is responsible in its own right (as a controller) only for: (a) this website, including its security cookie (section 9); and (b) administering the arrangements between the pharmacies, HHH and the clinic (section 3, last row).</p>
          <p>1.4 <strong>The clinic</strong> — Curaleaf Clinic, operated by Sapphire Medical Clinics Limited (company number 11927140; CQC provider ID 1-6943797921) — is responsible for your information once we refer you, and has its own privacy notice.</p>
          <p>1.5 <strong>Data Protection Officers.</strong> Your pharmacy’s Data Protection Officer is shown with its details when you select it. HHH’s Data Protection Officer can be contacted at <a href="mailto:dpo@holistichealthhub.live">dpo@holistichealthhub.live</a>.</p>

          <h2>2. What we collect</h2>
          <p>2.1 <strong>From the eligibility form:</strong> name, date of birth, postcode, email, mobile number; the pharmacy you selected or the pharmacy link you used; the conditions you want support with (up to three) and the main one; whether you have tried at least two licensed treatments; whether you or an immediate family member has been diagnosed with psychosis or schizophrenia; where you heard about the service; your consent choices.</p>
          <p>2.2 <strong>From our contact with you:</strong> notes of phone calls, emails and texts about your application, whether the contact is from our own team or from the HHH team on our behalf. Calls are not recorded.</p>
          <p>2.3 <strong>From your NHS record:</strong> in England, with your permission, a registered pharmacy professional on the HHH team, acting for us, views your Summary Care Record and uploads it to the clinic’s secure referral portal. Your record is not stored on the HHH platform. Outside England, you supply a copy yourself and it is uploaded in the same way.</p>
          <p>2.4 <strong>From your prescription and order:</strong> if you are prescribed, a copy of your prescription, the medicine and quantity, order status, payment status (not card details — Worldpay handles those), the date it was dispensed and, if we deliver to you, your delivery address and the courier’s proof of delivery. HHH’s software holds this for us.</p>
          <p>2.5 <strong>From your visit to this website (HHH as controller):</strong> technical data (IP address, browser, pages visited) held in server logs, and the security technologies described in section 9. No analytics.</p>
          <p>2.6 <strong>About other people:</strong> the family-history question concerns your immediate family. We record only your yes/no answer, never who the relative is, and we do not contact them.</p>

          <h2>3. Why we use it, and our legal basis</h2>
          <div className="hhh-legal-table">
            <table>
              <thead>
                <tr><th>Purpose</th><th>Who is responsible</th><th>Legal basis (UK GDPR Art. 6)</th><th>Special-category condition (Art. 9 / DPA 2018 Sch 1)</th></tr>
              </thead>
              <tbody>
                <tr><td>Reviewing your application and deciding whether to refer you</td><td>Your pharmacy (HHH acting for us)</td><td>Art. 6(1)(b) — steps you have asked for</td><td>Art. 9(2)(h) health care by GPhC-registered professionals under a duty of confidentiality (Sch 1 para 2); we also ask for your consent so that you are in control of the step</td></tr>
                <tr><td>Contacting you about your application</td><td>Your pharmacy (directly, or HHH acting for us)</td><td>Art. 6(1)(b)</td><td>Art. 9(2)(h)</td></tr>
                <tr><td>Viewing your Summary Care Record and uploading it to the clinic</td><td>Your pharmacy (HHH acting for us)</td><td>Art. 6(1)(b)</td><td>Art. 9(2)(h); your permission is asked before each view</td></tr>
                <tr><td>Sharing your application with the clinic</td><td>Your pharmacy</td><td>Art. 6(1)(b)</td><td>Art. 9(2)(h) and your consent</td></tr>
                <tr><td>Passing your application to another partner pharmacy</td><td>Your pharmacy</td><td>Your agreement — Art. 6(1)(a)</td><td>Art. 9(2)(a) explicit consent, given at the time</td></tr>
                <tr><td>Dispensing, payment, collection or delivery</td><td>Your pharmacy</td><td>Art. 6(1)(b), 6(1)(c) (medicines and controlled-drug record-keeping law)</td><td>Art. 9(2)(h)</td></tr>
                <tr><td>Marketing emails/texts, if you opted in</td><td>Your pharmacy and HHH jointly as senders</td><td>Art. 6(1)(a) consent; PECR reg. 22</td><td>Health information is never used to decide who receives marketing</td></tr>
                <tr><td>Complaints, legal claims, regulatory requests</td><td>Your pharmacy</td><td>Art. 6(1)(c)/(f)</td><td>Art. 9(2)(f) legal claims; Art. 9(2)(g) with Sch 1</td></tr>
                <tr><td>Website security (reCAPTCHA)</td><td>HHH</td><td>Art. 6(1)(f); PECR reg. 6 (strictly necessary)</td><td>—</td></tr>
                <tr><td>Administering the arrangements between the pharmacies, HHH and the clinic (referral reference and first-dispense date only — no clinical detail)</td><td>HHH</td><td>Art. 6(1)(f) legitimate interests — running the service</td><td>Sch 1 para 2(2)(f) management of health care services</td></tr>
              </tbody>
            </table>
          </div>
          <p>3.2 Where we rely on consent you can withdraw it at any time (section 7). Withdrawing before referral stops the referral. Withdrawing after referral does not affect the clinic’s records, which are the clinic’s.</p>
          <p>3.3 <strong>Automated screening.</strong> Two answers on the form are checked automatically against the clinic’s referral criteria: whether you have tried at least two licensed treatments, and whether you or an immediate family member has been diagnosed with psychosis or schizophrenia. If either falls outside the criteria, your application is declined automatically and you are told immediately. We do this with your explicit consent, given on the form, because the criteria are fixed by the clinic and applying them straight away saves you waiting. You can ask one of our pharmacists to review the result, tell us why you think it is wrong, and have it reconsidered, by emailing <a href="mailto:info@holistichealthhub.live">info@holistichealthhub.live</a>. No other decision about you is made by automated means.</p>

          <h2>4. Who we share it with</h2>
          <ul>
            <li><strong>The clinic (1.4):</strong> your application, your health record and contact details, so a specialist can decide whether to see you.</li>
            <li><strong>Another partner pharmacy:</strong> only if we cannot take you on and you agree to the transfer.</li>
            <li><strong>Our medicines supplier:</strong> we send it a copy of your prescription through HHH’s software so it can supply your medicine. The supplier is named in your pharmacy’s own privacy notice.</li>
            <li><strong>Our delivery courier, if we deliver to you:</strong> your name, address, phone number and the parcel reference — never what the medicine is. The courier is named in your pharmacy’s own privacy notice.</li>
            <li><strong>HHH’s service providers, acting on instructions:</strong> hosting with Google Cloud (London, europe-west2) and Vercel (London, lhr1); email delivery (Resend); Worldpay (payment links issued to you on our behalf — Worldpay handles card data; neither we nor HHH see it); Google (reCAPTCHA security check on every page).</li>
            <li><strong>Professional advisers, insurers, regulators, courts</strong> where required by law or to protect our legal position.</li>
          </ul>
          <p>We do not sell your information and do not share it with anyone for their own marketing.</p>

          {/*
            Regions verified 7 September 2026: Vercel lhr1 and Cloud SQL europe-west2 from
            repo config, and the storage bucket via `gcloud storage buckets describe
            gs://hhh26-4ebd2.firebasestorage.app` (EUROPE-WEST2, regional). Re-verify before
            republishing — this paragraph is a legal claim, not a deployment note.
          */}
          <h2>5. International transfers</h2>
          <p>Your information is stored in the United Kingdom, with Google Cloud in London (europe-west2) and Vercel in London (lhr1). The only transfer outside the UK is the reCAPTCHA security check, which sends technical data (not your application) to Google LLC in the United States under [TO CONFIRM — the UK Extension to the EU-US Data Privacy Framework / Google’s standard contractual clauses with the UK Addendum]. This site is protected by reCAPTCHA and the Google <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy</a> and <a href="https://policies.google.com/terms" target="_blank" rel="noopener noreferrer">Terms of Service</a> apply.</p>

          <h2>6. How long we keep it</h2>
          <div className="hhh-legal-table">
            <table>
              <thead>
                <tr><th>Information</th><th>Kept for</th></tr>
              </thead>
              <tbody>
                <tr><td>Applications we do not refer, or you withdraw</td><td>3 months from the decision or withdrawal, then deleted; a minimal record (name, date, outcome) is kept for 12 months to handle any query or complaint</td></tr>
                <tr><td>Applications we refer</td><td>2 years after your last activity with the service (last order, message or referral event), then deleted from HHH’s platform</td></tr>
                <tr><td>Your NHS record</td><td>Not stored by HHH. Upload logs (not the record) kept 90 days</td></tr>
                <tr><td>Prescription and order records</td><td>As required by medicines and controlled-drug law (private prescriptions for controlled drugs: at least 2 years) and our pharmacy retention policy</td></tr>
                <tr><td>Marketing consent</td><td>Until you unsubscribe; a suppression record is kept so we do not contact you again</td></tr>
                <tr><td>Call notes and emails</td><td>Same period as the application they relate to</td></tr>
                <tr><td>Website logs and cookies (HHH)</td><td>See section 9</td></tr>
              </tbody>
            </table>
          </div>

          <h2>7. Your rights</h2>
          <p>You can ask us to: give you a copy of your information (access); correct it; delete it; restrict or object to how we use it; give it to you or another organisation in a portable format; and you can withdraw consent at any time. For the automated screening in section 3.3, you can ask a pharmacist to review the result, tell us your view and contest it.</p>
          <p>Contact your pharmacy using the details shown when you selected it and in our messages to you. We will respond within one month and may ask you to confirm your identity. HHH will help us answer your request; for information held by the clinic, contact the clinic. For the website and cookies, contact HHH at <a href="mailto:privacy@holistichealthhub.live">privacy@holistichealthhub.live</a>.</p>
          <p>If you are unhappy with how your information is handled, please tell us first. You can also complain to the Information Commissioner’s Office: <a href="https://ico.org.uk/make-a-complaint" target="_blank" rel="noopener noreferrer">ico.org.uk/make-a-complaint</a>, 0303 123 1113.</p>

          <h2>8. How we protect it</h2>
          <p>Encryption in transit and at rest; access limited to named staff with a need to know, with access to patient records logged; staff bound by professional and contractual confidentiality; no health information in web addresses or browser storage. HHH team members access NHS records only with individual NHS smartcards issued under our Registration Authority and record your permission before each view. HHH is bound to us by a written data-processing contract.</p>

          <h2>9. Cookies and similar technologies (HHH as controller)</h2>
          <p>We use no analytics or advertising cookies. The only technologies used are:</p>
          <div className="hhh-legal-table">
            <table>
              <thead>
                <tr><th>Name</th><th>Provider</th><th>Purpose</th><th>Type</th><th>Duration</th></tr>
              </thead>
              <tbody>
                <tr><td>_GRECAPTCHA</td><td>Google</td><td>Protects the form against automated abuse</td><td>Strictly necessary for security</td><td>6 months</td></tr>
                <tr><td>Firebase App Check token (browser storage, not a cookie)</td><td>HHH</td><td>Proves the request comes from this website so the form can be submitted securely</td><td>Strictly necessary for security</td><td>Up to 24 hours</td></tr>
              </tbody>
            </table>
          </div>
          <p>This website sets no cookie of its own. Because nothing here is optional, no cookie banner is shown. If we introduce analytics in future we will update this notice and ask for your consent first.</p>

          <h2>10. Children</h2>
          <p>The service is for adults aged 18 and over. We delete any application from someone under 18.</p>

          <h2>11. Changes to this notice</h2>
          <p>Changes are posted here with the date at the top. If a change affects an open application we will email you.</p>
        </article>
      </main>
    </PageShell>
  );
}

function CostsPage() {
  return (
    <PageShell>
      <main id="main-content">
        <article className="hhh-legal hhh-section-inner">
          <div className="hhh-rise-copy hhh-page-head__intro">
            <p className="hhh-kicker">Costs</p>
            <h1>What the service costs</h1>
            <p>The eligibility check and the referral itself are free. Consultations are charged by the clinic, and medicine is charged separately by your pharmacy when you order it.</p>
          </div>

          {/*
            Interim wording. The fee table is held back until Curaleaf Clinic's current
            prices are confirmed — an empty or placeholder table on a live costs page is
            worse than none. When the figures arrive, restore the table here and add the
            "correct at" date; Terms 6.2 points patients at this page for them.
          */}
          <h2>Clinic consultation fees</h2>
          <p>Consultation fees are set and charged by Curaleaf Clinic, not by your pharmacy or by Holistic Health Hub. The clinic confirms the fees that apply to you before you book anything, and you are never charged for a consultation without being told the price first.</p>
          <p>Current clinic fees will be published on this page. In the meantime, your pharmacy can tell you what the clinic charges — contact it using the details shown when you selected it, or ask when a pharmacist first gets in touch about your application.</p>

          <h2>Medicine</h2>
          <p>Medicine is private and is charged separately by your pharmacy when you order it. The price depends on what the specialist prescribes and the quantity. Your pharmacy tells you the price of any medicine, and any delivery charge, before you pay.</p>

          <h2>What is free</h2>
          <ul>
            <li>The eligibility check.</li>
            <li>The pharmacy’s review of your application.</li>
            <li>The referral to the clinic, including gathering the health record the clinic needs.</li>
          </ul>

          <p>Full details of how charges work are in our <PublicLink href="/terms">Terms of Use</PublicLink>, section 6.</p>
        </article>
      </main>
    </PageShell>
  );
}

function NotFoundPage() {
  return (
    <PageShell>
      <main id="main-content">
        <section className="hhh-page-head">
          <div className="hhh-section-inner hhh-rise-copy">
          <p className="hhh-kicker">404 Error</p>
          <h1>We couldn’t find that page.</h1>
          <p>The link may have moved, or the page may no longer be published. Return home to continue your care journey.</p>
          <PublicLink href="/" className="hhh-button hhh-button--rust">
            Back to homepage <ArrowRight aria-hidden="true" />
          </PublicLink>
          </div>
        </section>
      </main>
    </PageShell>
  );
}

function updateMetaTag(selector: string, content: string | null) {
  let element = document.head.querySelector<HTMLMetaElement>(selector);
  if (content === null) {
    element?.remove();
    return;
  }
  if (!element) {
    element = document.createElement('meta');
    if (selector.startsWith('meta[name=')) {
      const name = selector.match(/name="([^"]+)"/)?.[1];
      if (name) element.setAttribute('name', name);
    } else if (selector.startsWith('meta[property=')) {
      const property = selector.match(/property="([^"]+)"/)?.[1];
      if (property) element.setAttribute('property', property);
    }
    document.head.appendChild(element);
  }
  element.content = content;
}

function updateCanonicalLink(url: string) {
  let element = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!element) {
    element = document.createElement('link');
    element.rel = 'canonical';
    document.head.appendChild(element);
  }
  element.href = url;
}

function updateJsonLd(schemaId: string, schema: object | null) {
  const existing = document.getElementById(schemaId);
  if (schema === null) {
    existing?.remove();
    return;
  }
  let script = existing as HTMLScriptElement | null;
  if (!script) {
    script = document.createElement('script');
    script.id = schemaId;
    script.type = 'application/ld+json';
    document.head.appendChild(script);
  }
  script.textContent = JSON.stringify(schema);
}

export default function PublicSite() {
  const { pathname } = usePublicLocation();
  const path = pathname.replace(/\/+$/, '') || '/';

  useEffect(() => {
    const isPost = path.startsWith('/post/');
    const article = isPost ? posts.find(item => item.slug === path.slice('/post/'.length)) : null;

    const pageMeta = article
      ? {
          title: `${article.title} | Holistic Health Hub Journal`,
          description: article.excerpt,
          type: 'article',
          is404: false,
        }
      : {
          '/': {
            title: 'Holistic Health Hub | UK Medical Cannabis & CBPM Specialist Referral',
            description: 'Access personalised medical cannabis (CBPM) care programmes through Holistic Health Hub, partnered specialist doctors and trusted community pharmacies.',
            type: 'website',
            is404: false,
          },
          '/how-it-works': {
            title: 'How It Works | 4-Step Medical Cannabis Consultation & Pharmacy Care | Holistic Health Hub',
            description: 'Discover the 4-step route to care: confidential pre-screening, specialist online doctor consultation, MDT review, and community pharmacy dispensing.',
            type: 'website',
            is404: false,
          },
          '/conditions': {
            title: 'Treatable Conditions | Medical Cannabis & Chronic Pain Referral | Holistic Health Hub',
            description: 'Learn about chronic pain, neurological, and psychiatric conditions considered for cannabis-based medicinal products (CBPM) in the UK.',
            type: 'website',
            is404: false,
          },
          '/about': {
            title: 'About Us | Specialist Clinicians & Community Pharmacy Network | Holistic Health Hub',
            description: 'Meet Holistic Health Hub. Discover our personal, pharmacy-connected approach to specialist medical care and our commitment to the planet.',
            type: 'website',
            is404: false,
          },
          '/faq': {
            title: 'Frequently Asked Questions | UK Medical Cannabis & CBPM Therapy | Holistic Health Hub',
            description: 'Clear, accurate answers to common questions about UK medical cannabis legality, eligibility, and the consultation process.',
            type: 'website',
            is404: false,
          },
          '/blog': {
            title: 'Journal & Educational Articles | Medical Cannabis & Wellbeing | Holistic Health Hub',
            description: 'Educational articles and clinical insights on sleep, chronic pain management, anxiety, the endocannabinoid system, and medical cannabis.',
            type: 'website',
            is404: false,
          },
          '/privacy': {
            title: 'Privacy Notice | UK GDPR & Data Protection | Holistic Health Hub',
            description: 'How your partner pharmacy and Holistic Health Hub use your information for the specialist referral service, your rights, and how long information is kept.',
            type: 'website',
            is404: false,
          },
          '/terms': {
            title: 'Terms of Use | Specialist Referral Service | Holistic Health Hub',
            description: 'The terms on which your partner pharmacy provides the specialist referral service, and on which Holistic Health Hub operates this website.',
            type: 'website',
            is404: false,
          },
          '/costs': {
            title: 'Costs | Clinic Fees & Medicine Charges | Holistic Health Hub',
            description: 'What the specialist referral service costs: the eligibility check and referral are free; clinic consultations and medicine are charged separately.',
            type: 'website',
            is404: false,
          },
        }[path as '/' | '/how-it-works' | '/conditions' | '/about' | '/faq' | '/blog' | '/privacy' | '/terms' | '/costs'] ?? {
          title: 'Page Not Found | Holistic Health Hub',
          description: 'The requested Holistic Health Hub page could not be found. Return to our homepage to continue.',
          type: 'website',
          is404: true,
        };

    const canonicalUrl = `${CANONICAL_ORIGIN}${path === '/' ? '/' : path}`;
    document.title = pageMeta.title;

    updateMetaTag('meta[name="description"]', pageMeta.description);
    updateMetaTag('meta[property="og:title"]', pageMeta.title);
    updateMetaTag('meta[property="og:description"]', pageMeta.description);
    updateMetaTag('meta[property="og:url"]', canonicalUrl);
    updateMetaTag('meta[property="og:type"]', pageMeta.type);
    updateMetaTag('meta[property="og:locale"]', 'en_GB');
    updateMetaTag('meta[property="og:image"]', `${CANONICAL_ORIGIN}/og.jpg`);
    updateMetaTag('meta[name="twitter:title"]', pageMeta.title);
    updateMetaTag('meta[name="twitter:description"]', pageMeta.description);
    updateMetaTag('meta[name="twitter:image"]', `${CANONICAL_ORIGIN}/og.jpg`);

    if (pageMeta.is404) {
      updateMetaTag('meta[name="robots"]', 'noindex, follow');
    } else {
      updateMetaTag('meta[name="robots"]', 'index, follow, max-image-preview:large');
    }

    updateCanonicalLink(canonicalUrl);

    // Organization & WebSite JSON-LD Schema
    updateJsonLd('hhh-schema-org', {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: 'Holistic Health Hub',
      url: CANONICAL_ORIGIN,
      logo: `${CANONICAL_ORIGIN}/holistic-health-hub-logo.png`,
      description: 'Personalised specialist healthcare connecting patients to specialist doctors and participating community pharmacies for cannabis-based medicinal products (CBPM).',
      address: {
        '@type': 'PostalAddress',
        streetAddress: '124 City Road',
        addressLocality: 'London',
        postalCode: 'EC1V 2NX',
        addressCountry: 'GB',
      },
      contactPoint: {
        '@type': 'ContactPoint',
        email: 'info@holistichealthhub.live',
        contactType: 'customer support',
      },
      sameAs: [
        'https://www.instagram.com/holistichealthhub1',
        'https://www.facebook.com/profile.php?id=61555967331192',
      ],
    });

    updateJsonLd('hhh-schema-website', {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: 'Holistic Health Hub',
      url: CANONICAL_ORIGIN,
    });

    // Page Specific Schema
    if (path === '/faq') {
      updateJsonLd('hhh-schema-faq', {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: faqs.map(([q, a]) => ({
          '@type': 'Question',
          name: q,
          acceptedAnswer: {
            '@type': 'Answer',
            text: a,
          },
        })),
      });
    } else {
      updateJsonLd('hhh-schema-faq', null);
    }

    if (article) {
      updateJsonLd('hhh-schema-article', {
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline: article.title,
        description: article.excerpt,
        author: {
          '@type': 'Person',
          name: article.author,
        },
        publisher: {
          '@type': 'Organization',
          name: 'Holistic Health Hub',
          logo: {
            '@type': 'ImageObject',
            url: `${CANONICAL_ORIGIN}/holistic-health-hub-logo.png`,
          },
        },
        datePublished: article.dateIso,
        mainEntityOfPage: canonicalUrl,
      });
    } else {
      updateJsonLd('hhh-schema-article', null);
    }

    return () => {
      // Clean up dynamic schemas on unmount
      updateJsonLd('hhh-schema-faq', null);
      updateJsonLd('hhh-schema-article', null);
    };
  }, [path]);

  if (path === '/') return <HomePage />;
  if (path === '/how-it-works') return <HowItWorksPage />;
  if (path === '/conditions') return <ConditionsPage />;
  if (path === '/pricing') {
    window.location.replace('/how-it-works');
    return null;
  }
  if (path === '/about') return <AboutPage />;
  if (path === '/faq' || path === '/general-5') return <FaqPage />;
  if (path === '/contact') {
    window.location.replace('/eligibility');
    return null;
  }
  if (path === '/blog' || path.startsWith('/blog/categories/')) return <BlogPage />;
  if (path === '/privacy' || path === '/general-5-1') return <PrivacyPage />;
  if (path === '/terms') return <TermsPage />;
  if (path === '/costs') return <CostsPage />;
  // /consent held the old combined consent-and-terms page. The approved pack splits
  // it into /terms and /privacy, so the retired path lands on the Terms of Use.
  if (path === '/consent') {
    window.location.replace('/terms');
    return null;
  }
  if (path.startsWith('/post/')) return <ArticlePage slug={path.slice('/post/'.length)} />;

  return <NotFoundPage />;
}
