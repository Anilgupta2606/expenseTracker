import type { Direction, Kind } from '../types';

export interface Rule {
  re: RegExp;
  kind: Kind;
  category: string;
  /** Only match this direction. Omit to match both. */
  dir?: Direction;
}

/**
 * Rules that decide the *type* of money movement. They run before the
 * self-transfer check, since narrations for salary, redemptions etc. often
 * contain the account holder's own name.
 */
export const PRIORITY_RULES: Rule[] = [
  // Credit card bill payments are not spend: the spend happened on the card.
  { re: /CREDIT ?CARD|INDMONEYCC|\bCC ?(BILL|PAYMENT|PMT)\b|CARD ?BILL|CRED ?CLUB|\bCRED\b|BILLPAY.*\d{4,6}X{3,}\d{4}|AUTOPAY.*CARD|\bPAVC\b/, kind: 'cc_bill', category: 'Credit Card Bill', dir: 'debit' },
  { re: /SALARY|PAYROLL|\bSAL\b.*\bCR\b/, kind: 'income', category: 'Salary', dir: 'credit' },
  { re: /\bDIV\b|DIVIDEND|\bDIV\d/, kind: 'income', category: 'Dividend', dir: 'credit' },
  { re: /REFUND|REVERSAL|\bRVSL\b|\bREV\b|CASHBACK|CASH BACK|ONE97|\bREWARD/, kind: 'income', category: 'Refund & Cashback', dir: 'credit' },
  { re: /\bINT\.? ?PD\b|INTEREST|\bINT\.?CR\b|\bSB ?INT\b|CREDIT INTEREST/, kind: 'income', category: 'Interest', dir: 'credit' },

  // Investments (both buying and redeeming)
  { re: /MUTUAL ?FUN|\bMF\b|\bSIP\b|MFSS|BSE ?STAR|\bCAMS\b|KFIN|KARVY|\bAMC\b|REDEMPTION|COIN BY ZERODHA|\bNCL\b.*MF/, kind: 'investment', category: 'Mutual Funds' },
  { re: /MMTC|SAFEGOLD|AUGMONT|DIGI ?GOLD|\bSGB\b|SOVEREIGN GOLD|GOLD ?BOND|\bJAR\b/, kind: 'investment', category: 'Gold' },
  { re: /\bRFX\b|\bLRS\b|VESTED|INDSTOCKS|US ?STOCK|OUTWARD REMIT|WIRE TRANSFER/, kind: 'investment', category: 'US Stocks / Foreign', dir: 'debit' },
  { re: /\bNPS\b|NATIONAL PENSION|\bPPF\b|\bEPF\b|PROVIDENT FUND|SUKANYA/, kind: 'investment', category: 'PPF / NPS / EPF' },
  { re: /\bFD\b.*(BOOK|OPEN)|FIXED DEPOSIT|TERM DEPOSIT|\bRD\b.*INST|RECURRING DEPOSIT|SWEEP/, kind: 'investment', category: 'Fixed Deposit' },
  { re: /ZERODHA|GROWW|UPSTOX|KUVERA|INDMONEY|PAYTM ?MONEY|\bICCL\b|INDIAN CLEARING|NSE ?CLEARING|NSE ?CLG|BSE LIMITED|SMALLCASE|\bDHAN\b|ANGEL ?(ONE|BROKING)|ICICI ?DIRECT|ICICI SECURITIES|\bEBA\b|5 ?PAISA|KOTAK SEC|HDFC ?SEC|MOTILAL|SHAREKHAN|NUVAMA|FYERS|STOCKS? BROK/, kind: 'investment', category: 'Stocks' },
];

/** Merchant rules. Debits are spend; a credit from a merchant is a refund. */
export const MERCHANT_RULES: Rule[] = [
  { re: /\bCGST\b|\bSGST\b|\bIGST\b|\bCHARGES?\b|\bCHGS?\b|\bFEE\b|SMS ALERT|ANNUAL FEE|DEBIT CARD FEE|\bAMC CHG|MIN BAL|NON MAINT|PENALTY/, kind: 'spend', category: 'Bank Charges' },
  { re: /CBDT|\bTIN\b|INCOME ?TAX|\bDTAX\b|\bIDTX\b|ADVANCE TAX|\bTDS\b|GST PAYMENT|PROFESSION TAX|PROPERTY TAX|MCD\b/, kind: 'spend', category: 'Taxes' },
  { re: /\bATM\b|\bNWD\b|\bATW\b|CASH ?WDL|CASH WITHDRAWAL|\bCCWD\b|\bEAW\b/, kind: 'spend', category: 'Cash Withdrawal' },
  { re: /\bEMI\b|\bLOAN\b|BAJAJ ?FIN|HOME CREDIT|\bLNPY\b|TATA CAPITAL|HDB FIN|FULLERTON|CAPITAL FIRST|KREDITBEE|NAVI ?FIN/, kind: 'spend', category: 'EMI & Loans' },
  { re: /\bLIC\b|LIFE INS|INSURANCE|POLICYBAZAAR|HDFC ?LIFE|ICICI ?PRU|SBI ?LIFE|MAX ?LIFE|TATA ?AIA|STAR ?HEALTH|NIVA ?BUPA|CARE ?HEALTH|GO ?DIGIT|\bACKO\b|BAJAJ ?ALLIANZ|PREMIUM/, kind: 'spend', category: 'Insurance' },
  { re: /NETFLIX|SPOTIFY|HOTSTAR|DISNEY|PRIME ?VIDEO|AMAZON ?PRIME|YOUTUBE|GOOGLE ?PLAY|APPLE\.COM|APPLE ?SERVICES|ITUNES|SONY ?LIV|\bZEE5\b|JIO ?CINEMA|AUDIBLE|LINKEDIN|MICROSOFT|ADOBE|OPENAI|CHATGPT|ANTHROPIC|CLAUDE\.AI|NOTION|DROPBOX|ICLOUD|GOOGLE ?ONE|\bBDAUTO\b/, kind: 'spend', category: 'Subscriptions' },
  { re: /SWIGGY|ZOMATO|DOMINO|PIZZA|MCDONALD|\bKFC\b|BURGER|STARBUCKS|\bCAFE\b|COFFEE|RESTAURANT|RESTRO|HALDIRAM|BIKANERVALA|SAGAR ?RATN|CHAAYOS|DHABA|BAKERY|BAKERS|SWEETS|\bEATS\b|\bFOODS?\b|BARBEQUE|BIRYANI|KITCHEN|CANTEEN|CHAI|TEA ?POINT|JUICE|DAIRY ?QUEEN|BASKIN|WOW ?MOMO|SUBWAY|EATCLUB|EATSURE/, kind: 'spend', category: 'Food & Dining' },
  { re: /BLINKIT|ZEPTO|BIG ?BASKET|INSTAMART|GROFERS|\bDMART\b|AVENUE SUPER|JIOMART|RELIANCE ?(FRESH|SMART|RETAIL)|MORE RETAIL|SPENCER|NATURE.?S BASKET|KIRANA|GROCER|\bMILK\b|DAIRY|MOTHER ?DAIRY|COUNTRY ?DELIGHT|VEGETABLE|SABZI|FRUITS?\b|SUPER ?MARKET|SUPER ?MART|PROVISION|GENERAL STORE|DEPARTMENTAL/, kind: 'spend', category: 'Groceries' },
  { re: /PHARMA|MEDIC|CHEMIST|APOLLO|\b1 ?MG\b|PHARMEASY|NETMEDS|HOSPITAL|CLINIC|DIAGNOS|PATHLAB|PATH LAB|\bLAB\b|DENTAL|HEALTHCARE|MEDANTA|FORTIS|PRACTO|NURSING|AYURVED|OPTICAL|LENSKART|DR\.? [A-Z]/, kind: 'spend', category: 'Health' },
  { re: /\bUBER\b|\bOLA\b|OLACABS|RAPIDO|\bMETRO\b|\bDMRC\b|FASTAG|\bNHAI\b|PARKING|BLUSMART|NAMMA ?YATRI|\bTOLL\b|\bCAB\b|TAXI/, kind: 'spend', category: 'Transport' },
  { re: /PETROL|\bFUEL|\bIOCL\b|INDIAN ?OIL|\bBPCL\b|BHARAT ?PETROLEUM|\bHPCL\b|HINDUSTAN ?PETRO|\bSHELL\b|NAYARA|FILLING|SERVICE ?STATION|\bCNG\b/, kind: 'spend', category: 'Fuel' },
  { re: /IRCTC|MAKEMYTRIP|MAKE MY TRIP|GOIBIBO|CLEARTRIP|YATRA|EASEMYTRIP|IXIGO|INDIGO|INTERGLOBE|AIR ?INDIA|VISTARA|AKASA|SPICEJET|\bOYO\b|AIRBNB|HOTEL|REDBUS|BOOKING\.COM|AGODA|\bTRAVEL|\bTOURS?\b|RESORT/, kind: 'spend', category: 'Travel' },
  { re: /AIRTEL|\bJIO\b|RELIANCE ?JIO|VODAFONE|\bVI\b|\bIDEA\b|BSNL|FIBERNET|HATHWAY|EXCITEL|TATA ?PLAY|TATA ?SKY|\bDTH\b|RECHARGE|\bRCHG\b|BROADBAND/, kind: 'spend', category: 'Mobile & Internet' },
  { re: /ELECTRICITY|\bBSES\b|TATA ?POWER|DHBVN|UHBVN|BESCOM|MSEDCL|ADANI ?ELEC|TORRENT ?POWER|\bPOWER\b|WATER ?(BILL|BOARD|SUPPLY)|JAL BOARD|\bGAS\b|\bIGL\b|INDRAPRASTHA ?GAS|MAHANAGAR ?GAS|\bLPG\b|INDANE|HP ?GAS|BHARAT ?GAS|\bBBPS\b|BILLDESK|BILLPAY|BILL ?PAY|MAINTENANCE|SOCIETY|\bRWA\b|APARTMENT/, kind: 'spend', category: 'Bills & Utilities' },
  { re: /\bRENT\b|NOBROKER|HOUSING\.COM|LANDLORD|\bPG\b.*RENT/, kind: 'spend', category: 'Rent & Housing' },
  { re: /SCHOOL|COLLEGE|UNIVERSITY|TUITION|COACHING|UDEMY|COURSERA|BYJU|UNACADEMY|VEDANTU|\bFEES?\b|ACADEMY|\bBOOKS?\b|STATIONER/, kind: 'spend', category: 'Education' },
  { re: /BOOKMYSHOW|\bPVR\b|\bINOX\b|CINEPOLIS|DISTRICT\b|PAYTM ?INSIDER|GAMING|\bSTEAM\b|PLAYSTATION|CINEMA|MOVIE|AMUSEMENT|FUN ?CITY|WONDERLA|KIDZANIA/, kind: 'spend', category: 'Entertainment' },
  { re: /SALON|\bSPA\b|PARLOU?R|URBAN ?COMPANY|URBANCLAP|GROOMING|BARBER|BEAUTY|UNISEX/, kind: 'spend', category: 'Personal Care' },
  { re: /DONATION|TEMPLE|MANDIR|GURUDWARA|CHARITY|\bNGO\b|PM ?CARES|GIVE ?INDIA|KETTO|MILAAP|FOUNDATION/, kind: 'spend', category: 'Gifts & Donations' },
  { re: /AMAZON|FLIPKART|MYNTRA|\bAJIO\b|NYKAA|MEESHO|TATA ?CLIQ|CROMA|RELIANCE ?DIGITAL|VIJAY ?SALES|DECATHLON|\bIKEA\b|LIFESTYLE|MAX ?RETAIL|LANDMARK|PANTALOONS|WESTSIDE|SHOPPERS ?STOP|\bZARA\b|\bH ?& ?M\b|UNIQLO|\bTRENDS\b|\bTOYS?\b|FIRSTCRY|\bMALL\b|PACIFIC|RETAIL|ELECTRONICS|FOOTWEAR|\bBATA\b|GARMENT|FASHION|CLOTH|APPAREL|JEWEL|TANISHQ|HARDWARE|FURNITURE|\bSTORES?\b|ENTERPRISES|TRADERS|EMPORIUM|BOUTIQUE|GIFT/, kind: 'spend', category: 'Shopping' },
];

/** VPA / narration markers of a merchant (as opposed to a person). */
export const MERCHANT_MARKERS = /PAYTMQR|^Q\d{6,}@|BHARATPE|\.D\d{6,}@|PAYTM\.D\d|PAYTM-\d|MCHUPI|MERUPI|RAZORPAY|\bPAYU\b|CASHFREE|BDPG|BILLDESK|\.BRK|\bMAB\.|PINELABS|MSWIPE|EZETAP|\bPOS\b|MERCHANT|@HDFCBANK$|@YESBANKLTD|@ICICI$|@AXISBANK$|VYAPAR|GPAY-\d|OKBIZ/;

/** Words that mark a company, so a narration with the holder's name isn't a self transfer. */
export const COMPANY_MARKERS = /PRIVATE|\bPVT\b|LIMITED|\bLTD\b|\bLLP\b|\bINC\b|CORP|TECHNOLOG|SOLUTIONS|SERVICES|INDUSTRIES|ENTERPRISE|\bTRUST\b|FOUNDATION/;

export const TRANSFER_METHOD = /\bUPI\b|\bIMPS\b|\bNEFT\b|\bRTGS\b|\bMMT\b|\bINFT\b|\bINF\b|\bTPT\b|\bTRF\b|TRANSFER|FUND ?TRF|\bFT\b/;
