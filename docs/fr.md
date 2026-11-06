# LOQED pour Gladys Assistant

Intégration non officielle, sans lien avec LOQED. Elle amène une serrure
connectée **LOQED Touch** dans Gladys par l'**API locale de son pont** (le
petit boîtier branché près de la porte), sur votre réseau, sans le cloud LOQED.

**Jamais testée avec une vraie serrure** : elle a été écrite d'après la
bibliothèque loqedAPI (utilisée par Home Assistant) et testée contre un faux
pont. Vos retours sont les bienvenus.

## Ce que vous obtenez

Un appareil par pont (une serrure), avec :

| Fonctionnalité     | Type           | Détail                                                                      |
| ------------------ | -------------- | --------------------------------------------------------------------------- |
| État de la serrure | serrure / état | 1 verrouillée (nuit), 0 déverrouillée ou ouverte, 2 en mouvement, 3 bloquée |
| Position           | texte          | la position en toutes lettres                                               |
| Batterie           | batterie (%)   | jamais publiée quand la serrure est hors de portée du pont                  |
| Verrouiller        | bouton         | toujours autorisé                                                           |
| Déverrouiller      | bouton         | refusé tant que l'option n'est pas activée                                  |
| Ouvrir la porte    | bouton         | tire le pêne ; refusé sans les deux options                                 |
| Dernière commande  | texte          | la dernière commande et son issue                                           |

Les commandes sont des **boutons**, jamais un interrupteur : un « tout
éteindre » (assistant vocal, scène sur les interrupteurs) ne peut pas
déverrouiller la porte.

## Configuration

1. Dans l'application web LOQED, créez une **clé d'API locale** pour votre
   serrure. La page affiche (noms à vérifier sur une vraie installation) :
   `bridge_ip`, `lock_key_local_id`, `lock_key_key` et `bridge_key`.
2. Donnez au pont une adresse IP fixe dans votre box.
3. Dans Gladys, **Intégrations → LOQED → Configuration** :
   - **Adresse IP du pont** : `bridge_ip` (une adresse IP, pas un nom) ;
   - **Numéro de clé** : `lock_key_local_id` (0 à 255) ;
   - **Clé locale** : `lock_key_key` ;
   - **Clé du pont** : `bridge_key` (facultative : sans elle, pas de webhook).
4. Enregistrez, puis **Découverte** : la serrure apparaît après la première
   lecture du pont ; ajoutez-la.

Les deux clés sont gardées par Gladys dans sa base, jamais réaffichées, jamais
écrites dans les journaux ni dans `/data`. Elles ne circulent jamais sur le
réseau : seules les signatures qu'elles produisent partent vers le pont. Le pont
parle en HTTP simple (pas de HTTPS) : quelqu'un qui voit le trafic de votre
réseau voit l'état de la serrure et les commandes signées (horodatées, donc
périmées après peu de temps).

L'heure de la machine Gladys doit être juste : chaque commande porte l'heure, et
le pont refuse sans doute une commande trop décalée (à vérifier).

### Mises à jour immédiates (webhooks)

Le pont peut prévenir Gladys de chaque changement aussitôt. Saisissez
**l'adresse IP de Gladys** telle que le pont la voit : l'intégration démarre un
petit récepteur à côté d'elle (Gladys choisit son port) et inscrit elle-même son
adresse sur le pont, signée avec la clé du pont. Chaque webhook reçu est vérifié
avant de compter :

- l'adresse exacte (avec un jeton aléatoire) et la méthode POST ;
- la signature du pont (`HASH`, faite avec la clé du pont) ;
- l'heure du pont à 30 s près de celle du récepteur ; un webhook resté plus de
  60 s dans le récepteur est ignoré ; un webhook rejoué est refusé ; un webhook
  daté d'avant le dernier démarrage de l'intégration déclenche seulement une
  lecture ;
- l'adresse de l'expéditeur, égale à celle du pont (option « N'accepter les
  webhooks que depuis l'adresse du pont », activée par défaut) ;
- l'adresse MAC du pont quand le webhook la donne.

Le récepteur borne tout : 4 Ko par webhook, 16 connexions (4 par adresse),
10 s par requête, 120 webhooks par minute (30 pour une autre adresse que celle
du pont). L'intégration ne retire du pont que les adresses qu'elle y a inscrites
elle-même (celles d'autres logiciels restent).

Sans adresse de Gladys ou sans clé du pont, le pont est seulement lu à
l'intervalle choisi (30 s par défaut, de 10 à 600 s).

## Verrouiller

Le verrouillage (verrou de nuit) part **tout de suite**, quelles que soient les
options, une lecture en cours (elle est coupée), une pause demandée par le pont,
l'identité du pont, ou `/data` (jamais attendu sur ce chemin). Ensuite :

- s'il n'a pas pu partir (pont injoignable), il est réessayé pendant 250 ms,
  puis gardé dans `/data` et renvoyé toutes les 10 s jusqu'à ce qu'il parte ; il
  n'est jamais abandonné pour cette raison, et il repart au redémarrage de
  l'intégration avant toute lecture ;
- il est confirmé par une lecture du pont **partie après lui** qui montre la
  serrure verrouillée ; tant que ce n'est pas le cas, il est renvoyé (au plus
  toutes les 6 s) ;
- seul un envoi auquel le pont a répondu « OK » compte comme essai : après
  3 envois acceptés sans que la serrure se dise verrouillée, il est abandonné et
  « Dernière commande » le dit. Une coupure, un délai, une erreur du pont ou un
  refus de la clé ne comptent pas ;
- une manœuvre faite ensuite avec une autre clé (application, clavier),
  signalée par un webhook signé au moins 2 s après l'envoi, met fin aux renvois.

Le verrouillage reste en attente, sans partir, dans ces cas seulement :

- pas d'adresse du pont, ou numéro de clé ou clé locale invalides : il part dès
  qu'ils sont enregistrés ;
- le pont a refusé la clé locale : chaque clic l'envoie encore une fois, mais il
  ne repart plus de lui-même tant qu'une autre clé n'est pas enregistrée ou que
  « Tester la connexion » n'a pas réussi (il part alors en premier).

Un verrouillage cliqué avant que `/data` soit lu (au démarrage) est gardé et
fusionné avec ce que `/data` contient. Si `/data` est illisible, le verrouillage
part quand même ; `/data` est relu toutes les 10 s, et dès qu'il redevient lisible
le verrouillage y est écrit (ou celui qu'il contenait part aussitôt).

Le statut dit où en est un verrouillage en attente : pas encore parti, en cours
d'envoi, parti sans confirmation, ou retenu par une clé refusée.

## Déverrouiller et ouvrir

Désactivés par défaut : **Autoriser le déverrouillage** permet Déverrouiller
(verrou de jour) ; **Ouvrir la porte** (tirer le pêne) demande cette option
**et** « Autoriser l'ouverture de la porte ». Une commande à la fois. Chacune
est refusée, sans rien envoyer, si :

- l'option manque (vérifiée encore juste avant le premier octet) ;
- une autre commande de déverrouillage ou d'ouverture est en cours ;
- le numéro de clé ou la clé locale manquent, ou le pont les a refusés ;
- `/data` est illisible, ou la garde de la commande n'a pas pu y être écrite
  dans les 2 s (et au plus 3,2 s après le clic) ;
- le pont a demandé une pause (erreur 429 ou 5xx) : le motif dit le temps
  restant ;
- un verrouillage est en attente, ou a été demandé pendant la commande ;
- le pont n'est pas encore identifié, ou un autre pont répond à l'adresse ;
- la lecture du pont faite après le clic a échoué ou n'est pas venue en 2,5 s ;
- la serrure n'est pas connectée au pont, ou elle est en mouvement, bloquée ou
  dans un état inconnu ;
- elle n'a pas pu partir dans les 3,5 s après le clic.

Déverrouiller une serrure déjà déverrouillée n'envoie rien. Une commande partie
sans réponse du pont est signalée « envoyée, sans confirmation » (la serrure
peut bouger) et la serrure est relue.

## Statut et actions

Le statut de l'écran Configuration dit si le pont répond, si les webhooks sont
actifs, si un verrouillage attend, si la serrure est hors de portée, et pourquoi
quelque chose est refusé. Un pont qui répond une erreur 429 ou 5xx met en pause
(1 min à 6 h) les lectures, le déverrouillage, l'ouverture et les actions ;
seuls le verrouillage et les lectures qui le confirment passent quand même.

- **Tester la connexion** : lit le pont (une fois au plus, et jamais plus souvent
  que l'intervalle : une lecture plus récente est reprise), inscrit le webhook, et lève un refus de
  la clé locale (un verrouillage en attente part alors en premier). La clé
  locale ne peut être vérifiée que par une vraie commande.
- **Utiliser le pont qui répond maintenant** : seulement après un remplacement
  du pont. Appuyez deux fois dans la minute ; sa serrure devient un nouvel
  appareil (l'identifiant de l'appareil est l'adresse MAC du pont).

## Limites connues

- Un seul pont (une serrure) par installation de l'intégration.
- Pas de Bluetooth, pas de cloud LOQED.
- Les réglages de la serrure (mode fête, accès invité) ne sont pas lus.
