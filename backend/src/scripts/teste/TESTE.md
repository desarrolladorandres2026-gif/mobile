# TESTE — entorno de prueba de ZIPP

> Generado por `npm run teste:report` desde `src/scripts/teste/data/`. No editar a mano: lo que aquí se lee es exactamente lo que siembra `npm run teste:seed`.

**5 comercios · 50 productos · 20 categorías · 86 grupos de modificadores · 267 opciones (3 agotadas a propósito) · 60 fotografías.**

Los comercios son ficticios pero están construidos como comercios reales. Se distinguen por las cuentas de sus dueños (`@teste.zipp.co`, teléfonos `300999xxxx`), nunca por el nombre: en la app se ven como cualquier otro negocio. `npm run teste:teardown` los borra sin tocar nada más.

## Cuentas

Contraseña de todas: `Teste.2026`

| Rol | Nombre | Teléfono | Correo | Para |
|---|---|---|---|---|
| Comercio | Mauricio Cerón | 3009990001 | dueno.c21@teste.zipp.co | Panel de Callejón 21 |
| Comercio | Gloria Amparo Losada | 3009990002 | dueno.tul@teste.zipp.co | Panel de Sazón de la Tulia |
| Comercio | Daniel Restrepo | 3009990003 | dueno.cyp@teste.zipp.co | Panel de Carbón & Pan |
| Comercio | Lucía Fernanda Ortiz | 3009990004 | dueno.tyt@teste.zipp.co | Panel de Trigo & Tinto |
| Comercio | Jairo Alberto Muñoz | 3009990005 | dueno.sur@teste.zipp.co | Panel de Autoservicio Punto Fresco |
| Cliente | Camila Andrade | 3009990011 | cliente1@teste.zipp.co | App móvil (Casa) |
| Cliente | Andrés Felipe Rojas | 3009990012 | cliente2@teste.zipp.co | App móvil (Oficina) |

Los domiciliarios son los de demostración que ya existen (`npm run seed:demo-drivers`): Pedro `3111234567` y Luis `3121234567`.

## Los cinco comercios

| Comercio | Categoría | Horario | Prep. | Pedido mín. | Envío gratis desde | Dirección |
|---|---|---|---|---|---|---|
| **Callejón 21** | `fast_food` | Lun 00:00–23:59 · Mar 00:00–23:59 · Mié 00:00–23:59 · Jue 00:00–23:59 · Vie 00:00–23:59 · Sáb 00:00–23:59 · Dom 00:00–23:59 | 25 min | — | $45.000 | Calle 21 # 8-14, barrio Centro · tel. 3009990101 |
| **Sazón de la Tulia** | `restaurant` | Lun 00:00–23:59 · Mar 00:00–23:59 · Mié 00:00–23:59 · Jue 00:00–23:59 · Vie 00:00–23:59 · Sáb 00:00–23:59 · Dom 00:00–23:59 | 35 min | $15.000 | — | Carrera 5 # 12-40, barrio La Esperanza · tel. 3009990102 |
| **Carbón & Pan** | `fast_food` | Lun 00:00–23:59 · Mar 00:00–23:59 · Mié 00:00–23:59 · Jue 00:00–23:59 · Vie 00:00–23:59 · Sáb 00:00–23:59 · Dom 00:00–23:59 | 30 min | — | $60.000 | Calle 15 # 9-22, barrio San José · tel. 3009990103 |
| **Trigo & Tinto** | `cafe` | Lun 00:00–23:59 · Mar 00:00–23:59 · Mié 00:00–23:59 · Jue 00:00–23:59 · Vie 00:00–23:59 · Sáb 00:00–23:59 · Dom 00:00–23:59 | 15 min | — | — | Carrera 7 # 18-05, barrio Las Mercedes · tel. 3009990104 |
| **Autoservicio Punto Fresco** | `supermarket` | Lun 00:00–23:59 · Mar 00:00–23:59 · Mié 00:00–23:59 · Jue 00:00–23:59 · Vie 00:00–23:59 · Sáb 00:00–23:59 · Dom 00:00–23:59 | 20 min | $15.000 | $50.000 | Calle 9 # 4-31, barrio Guaduales · tel. 3009990105 |

### Callejón 21

Comidas rápidas de esquina, de las de verdad: perros, salchipapas, pizza en horno de piedra y alitas ahumadas. Salsas de la casa y porciones para compartir. Abiertos hasta la 1 de la mañana.

Secciones del menú: **Perros y salchipapas** · **Pizza y sándwiches** · **Para compartir** · **Bebidas**

| Producto | Sección | Precio | Modificadores | Otros |
|---|---|---|---|---|
| **Perro Americano** | Perros y salchipapas | $12.900 | **Salsas** (opcional, hasta 4): Rosada, Piña, Ajo, BBQ, Mostaza, Showy<br>**Adiciones** (opcional, hasta 3): Salchicha extra +$3.500, Tocineta +$3.000, Queso extra +$2.000, Huevo de codorniz x3 +$2.500 | destacado |
| **Salchipapa Ranchera** | Perros y salchipapas | $19.900 | **Tamaño** (obligatorio, elige 1): Personal, Para dos +$9.000, Familiar +$17.000<br>**Salsas** (opcional, hasta 4): Rosada, Piña, Ajo, BBQ, Mostaza, Showy | — |
| **Pizza Mitad y Mitad** | Pizza y sándwiches | $38.900 | **Tamaño** (obligatorio, elige 1): Mediana (6 porciones), Familiar (8 porciones) +$12.000<br>**Masa** (obligatorio, elige 1): Tradicional, Delgada, Integral +$2.000<br>**Primera mitad** (obligatorio, elige 1): Hawaiana, Pepperoni, Pollo con champiñones, Vegetariana, Carnes frías +$3.000<br>**Segunda mitad** (obligatorio, elige 1): Hawaiana, Pepperoni, Pollo con champiñones, Vegetariana, Carnes frías +$3.000<br>**Borde** (opcional, hasta 1): Borde de queso +$6.000<br>**Ingredientes extra** (opcional, hasta 3): Queso extra +$4.000, Maíz tierno +$2.500, Jalapeños +$2.500, Tocineta +$4.000 | destacado |
| **Mazorcada Mixta** | Para compartir | $26.500 | **Proteínas** (obligatorio, 1–2): Pollo desmechado, Carne desmechada, Chorizo +$2.000, Tocineta +$2.500<br>**Salsas** (opcional, hasta 4): Rosada, Piña, Ajo, BBQ, Mostaza, Showy | — |
| **Sándwich Cubano** | Pizza y sándwiches | $18.500 | **Pan** (obligatorio, elige 1): Hojaldre, Baguette, Sin gluten +$3.000<br>**Acompañante** (opcional, hasta 1): Papas francesas +$5.000, Ensalada de la casa +$4.500 | — |
| **Patacón con Todo** | Para compartir | $21.000 | **Proteína** (obligatorio, elige 1): Carne desmechada, Pollo desmechado, Chicharrón +$3.000, Mixto +$4.500 | — |
| **Choripapa** | Perros y salchipapas | $17.500 | **Salsas** (opcional, hasta 4): Rosada, Piña, Ajo, BBQ, Mostaza, Showy | 2 extras planos |
| **Alitas BBQ x8** | Para compartir | $24.900 | **Salsa** (obligatorio, elige 1): BBQ ahumada, Búfalo picante, Miel mostaza, Teriyaki +$1.000<br>**Acompañante** (obligatorio, elige 1): Papas francesas, Yuca frita, Ensalada<br>**Dips** (opcional, hasta 2): Ranch +$1.500, Queso azul +$2.000, Ajo +$1.000 | destacado |
| **Jugo Natural 16 oz** | Bebidas | $8.500 | **Fruta** (obligatorio, elige 1, 1 agotada): Mora, Lulo, Maracuyá, Mango, Guanábana +$1.500 ⛔<br>**Preparación** (obligatorio, elige 1): En agua, En leche +$1.500<br>**Endulzante** (obligatorio, elige 1): Azúcar, Panela, Stevia, Sin endulzar | — |
| **Gaseosa 1,5 L** | Bebidas | $7.500 | — | stock 20 (aviso 5) |

### Sazón de la Tulia

Cocina tradicional colombiana en fogón de leña: bandeja paisa, ajiaco, sancocho trifásico y mojarra fresca. Recetas de familia, porciones generosas y jugos de fruta de temporada. Descansamos los lunes.

Secciones del menú: **Platos fuertes** · **Sopas** · **Para picar** · **Postres y bebidas**

| Producto | Sección | Precio | Modificadores | Otros |
|---|---|---|---|---|
| **Bandeja Paisa** | Platos fuertes | $32.000 | **Porción** (obligatorio, elige 1): Tradicional, Doble carne +$8.000, Con chorizo extra +$4.000<br>**Adiciones** (opcional, hasta 3, 1 agotada): Chicharrón extra +$6.000 ⛔, Aguacate extra +$3.000, Huevo extra +$2.000, Arepa extra +$1.500 | destacado |
| **Ajiaco Santafereño** | Sopas | $27.500 | **Acompañantes incluidos** (opcional, hasta 3): Crema de leche, Alcaparras, Aguacate, Arroz blanco | — |
| **Sancocho Trifásico** | Sopas | $29.000 | **Porción** (obligatorio, elige 1): Personal, Para llevar (olla 1 L) +$4.000 | — |
| **Mojarra Frita** | Platos fuertes | $34.000 | **Tamaño** (obligatorio, elige 1): Mediana (450 g), Grande (650 g) +$9.000<br>**Acompañantes (elige 2)** (obligatorio, elige 2): Patacones, Arroz con coco, Ensalada, Yuca cocida, Papa salada | destacado |
| **Lechona Tolimense** | Platos fuertes | $24.000 | **Porción** (obligatorio, elige 1): Plato, Libra para llevar +$12.000 | no disponible |
| **Sobrebarriga en Salsa Criolla** | Platos fuertes | $30.500 | **Acompañantes (elige 2)** (obligatorio, elige 2): Arroz blanco, Papa criolla, Yuca, Ensalada | — |
| **Empanadas de Pipián x4** | Para picar | $9.000 | **Ají** (obligatorio, elige 1): Ají de maní, Ají de cilantro, Sin ají | — |
| **Tamal Tolimense** | Para picar | $16.500 | **Acompañantes** (opcional, hasta 2): Arepa blanca +$1.500, Chocolate caliente +$4.500, Queso campesino +$3.000 | — |
| **Arroz con Leche** | Postres y bebidas | $7.500 | **Toppings** (opcional, hasta 2): Canela extra, Coco rallado +$800, Arequipe +$1.500 | — |
| **Limonada de Panela** | Postres y bebidas | $6.000 | **Temperatura** (obligatorio, elige 1): Fría, Caliente | — |

### Carbón & Pan

Hamburguesas de carne madurada a la parrilla de carbón, en pan brioche horneado cada mañana. Papas rústicas, aros de cebolla y malteadas de verdad. Arma la tuya como quieras.

Secciones del menú: **Hamburguesas** · **Acompañantes** · **Bebidas**

| Producto | Sección | Precio | Modificadores | Otros |
|---|---|---|---|---|
| **Clásica de la Casa** | Hamburguesas | $22.900 | **Tipo de carne** (obligatorio, elige 1): Res 120 g, Angus 150 g +$7.000, Pollo a la parrilla<br>**Término** (opcional, hasta 1): Medio, Tres cuartos, Bien cocido<br>**Queso** (opcional, hasta 1): Cheddar +$2.500, Mozzarella +$2.500, Queso azul +$3.500<br>**Tocineta** (opcional, hasta 1): Tocineta +$3.500, Tocineta doble +$6.000<br>**Salsas** (opcional, hasta 3): De la casa, BBQ, Chipotle +$1.000, Ajo asado +$1.000, Mostaza miel<br>**Vegetales** (opcional, hasta 4): Sin cebolla, Sin tomate, Pepinillos, Cebolla caramelizada +$1.500, Jalapeños +$1.000<br>**Papas** (opcional, hasta 1): Francesas +$6.000, Rústicas +$6.500, Cascos con queso +$8.500<br>**Bebida** (opcional, hasta 1): Gaseosa 350 ml +$4.500, Limonada de hierbabuena +$5.500, Malteada pequeña +$9.000 | destacado |
| **Doble Smash** | Hamburguesas | $29.900 | **Queso** (obligatorio, elige 1): Cheddar americano, Suizo +$1.000<br>**Tocineta** (opcional, hasta 1): Tocineta +$3.500<br>**Papas** (opcional, hasta 1): Francesas +$6.000, Rústicas +$6.500, Cascos con queso +$8.500<br>**Bebida** (opcional, hasta 1): Gaseosa 350 ml +$4.500, Limonada de hierbabuena +$5.500, Malteada pequeña +$9.000 | destacado |
| **Crispy Chicken** | Hamburguesas | $24.500 | **Picante** (obligatorio, elige 1): Sin picante, Suave, Fuerte<br>**Salsas** (opcional, hasta 2): Ranch, Miel mostaza, Búfalo +$1.000<br>**Papas** (opcional, hasta 1): Francesas +$6.000, Rústicas +$6.500, Cascos con queso +$8.500 | — |
| **BBQ Ahumada** | Hamburguesas | $27.900 | **Tipo de carne** (obligatorio, elige 1): Res 120 g, Angus 150 g +$7.000<br>**Término** (opcional, hasta 1): Medio, Tres cuartos, Bien cocido<br>**Adiciones** (opcional, hasta 3): Carne extra +$8.000, Aros de cebolla dentro +$2.500, Huevo frito +$2.000, Jalapeños +$1.000<br>**Papas** (opcional, hasta 1): Francesas +$6.000, Rústicas +$6.500, Cascos con queso +$8.500<br>**Bebida** (opcional, hasta 1): Gaseosa 350 ml +$4.500, Limonada de hierbabuena +$5.500, Malteada pequeña +$9.000 | — |
| **Veggie de Garbanzo** | Hamburguesas | $23.500 | **Pan** (obligatorio, elige 1, 1 agotada): Brioche, Integral, Sin gluten +$3.000 ⛔<br>**Queso** (opcional, hasta 1): Mozzarella +$2.500, Queso vegano +$3.500<br>**Papas** (opcional, hasta 1): Francesas +$6.000, Rústicas +$6.500, Cascos con queso +$8.500 | — |
| **Papas Rústicas** | Acompañantes | $11.500 | **Tamaño** (obligatorio, elige 1): Personal, Para compartir +$6.000<br>**Toppings** (opcional, hasta 2): Queso cheddar fundido +$3.500, Tocineta en trozos +$3.500, Cebollín | — |
| **Aros de Cebolla x10** | Acompañantes | $12.900 | **Dip** (obligatorio, elige 1): Ranch, BBQ, Chipotle +$500 | — |
| **Nuggets de Pollo x8** | Acompañantes | $16.900 | **Salsas (1 o 2)** (obligatorio, 1–2): BBQ, Miel mostaza, Ranch, Búfalo +$500 | — |
| **Malteada de Arequipe** | Bebidas | $14.500 | **Tamaño** (obligatorio, elige 1): 12 oz, 16 oz +$3.000<br>**Extras** (opcional, hasta 2): Brownie en trozos +$2.500, Chantilly extra +$1.000, Galleta +$1.500 | — |
| **Limonada de Hierbabuena** | Bebidas | $8.900 | **Tamaño** (obligatorio, elige 1): 12 oz, 16 oz +$2.000, Jarra 1 L +$9.000<br>**Endulzante** (obligatorio, elige 1): Azúcar, Panela, Stevia, Sin endulzar | — |

### Trigo & Tinto

Panadería de barrio con horno de leña y café de origen. Pandebonos y almojábanas calientes desde las seis, croissants de mantequilla, desayunos y tortas caseras. Lo que sale del horno se acaba.

Secciones del menú: **Café** · **Panadería** · **Desayunos** · **Tortas**

| Producto | Sección | Precio | Modificadores | Otros |
|---|---|---|---|---|
| **Capuchino** | Café | $7.500 | **Tamaño** (obligatorio, elige 1): 8 oz, 12 oz +$1.500, 16 oz +$2.800<br>**Leche** (obligatorio, elige 1): Entera, Deslactosada, Almendras +$2.000, Avena +$2.000<br>**Endulzante** (obligatorio, elige 1): Azúcar, Panela, Stevia, Sin endulzar<br>**Sabor** (opcional, hasta 1): Vainilla +$1.500, Caramelo +$1.500, Avellana +$1.500<br>**Extra shot** (opcional, hasta 1): Shot adicional de espresso +$2.500 | destacado |
| **Tinto Campesino** | Café | $3.500 | **Tamaño** (obligatorio, elige 1): 8 oz, 12 oz +$1.500, 16 oz +$2.800<br>**Endulzante** (obligatorio, elige 1): Azúcar, Panela, Stevia, Sin endulzar | — |
| **Frappé de Café** | Café | $11.900 | **Tamaño** (obligatorio, elige 1): 12 oz, 16 oz +$2.500<br>**Leche** (obligatorio, elige 1): Entera, Deslactosada, Almendras +$2.000<br>**Chantilly** (opcional, hasta 1): Con chantilly | — |
| **Pandebono** | Panadería | $2.800 | — | stock 24 (aviso 6) |
| **Almojábana** | Panadería | $2.800 | — | stock 18 (aviso 6) |
| **Croissant de Almendras** | Panadería | $8.500 | — | destacado, stock 6 (aviso 3) |
| **Desayuno Huevos al Gusto** | Desayunos | $16.900 | **Huevos** (obligatorio, elige 1): Pericos, Fritos, Revueltos, Con tocineta +$3.500<br>**Acompañante** (obligatorio, elige 1): Arepa con queso, Pan de la casa, Calentado +$3.000<br>**Bebida incluida** (obligatorio, elige 1): Tinto, Chocolate, Jugo de naranja +$2.000 | — |
| **Croissant de Jamón y Queso** | Desayunos | $13.500 | **Preparación** (obligatorio, elige 1): Gratinado al horno, Frío | — |
| **Torta de Zanahoria** | Tortas | $9.500 | — | no disponible, descuento $8.000, stock 0 |
| **Chocolate Santafereño** | Café | $8.900 | **Con queso** (opcional, hasta 1): Queso campesino +$2.500<br>**Acompañante** (opcional, hasta 1): Almojábana +$2.800, Pandebono +$2.800, Mantequilla y pan +$2.000 | — |

### Autoservicio Punto Fresco

Minimercado de barrio con fruta y verdura del día, lácteos, granos, panadería y aseo. Lo que falta en la casa, en veinte minutos.

Secciones del menú: **Frutas y verduras** · **Lácteos y huevos** · **Despensa** · **Bebidas** · **Aseo**

| Producto | Sección | Precio | Modificadores | Otros |
|---|---|---|---|---|
| **Huevos AA x30** | Lácteos y huevos | $19.900 | — | destacado, stock 12 (aviso 4) |
| **Leche Entera 1,1 L** | Lácteos y huevos | $4.800 | — | stock 40 (aviso 10) |
| **Arroz Blanco 1 kg** | Despensa | $5.200 | — | stock 35 |
| **Pan Tajado Artesanal** | Despensa | $7.900 | **Presentación** (obligatorio, elige 1): Blanco, Integral +$800 | stock 10 (aviso 3) |
| **Aguacate Hass (unidad)** | Frutas y verduras | $3.500 | **Madurez** (obligatorio, elige 1): Para hoy, Para 2–3 días | stock 30 |
| **Tomate Chonto (libra)** | Frutas y verduras | $3.200 | — | stock 50 |
| **Queso Campesino 500 g** | Lácteos y huevos | $12.500 | **Tajado** (opcional, hasta 1): Tajado | stock 8 (aviso 3) |
| **Cerveza Nacional six pack** | Bebidas | $22.000 | **Temperatura** (obligatorio, elige 1): Fría, Al clima | stock 15, mayor de edad |
| **Agua sin Gas 600 ml** | Bebidas | $2.500 | **Temperatura** (obligatorio, elige 1): Fría, Al clima | stock 60 |
| **Detergente en Polvo 1 kg** | Aseo | $12.900 | — | descuento $10.900, stock 25 |

## Fotografías, fuentes y licencias

Las 60 son de **Unsplash**, bajo la [Unsplash License](https://unsplash.com/license): uso comercial y no comercial, sin atribución obligatoria (se registra igual el autor). Se excluyeron las de Unsplash+ (de pago) y las patrocinadas, se exigió lado corto ≥ 1200 px y cada una se revisó a ojo: que corresponda al producto, sin marcas, sin marcas de agua y sin personas reconocibles. Ninguna foto se repite.

| Clave | Uso | Autor | Foto | Tamaño |
|---|---|---|---|---|
| `c21.cover` | Callejón 21 — Portada | [Diego Arenas de Rodrigo](https://unsplash.com/@diegoarenasderodrigo) | [JGrLYVFQYH8](https://unsplash.com/photos/heart-shaped-egg-on-fries-with-sausages-and-burgers-JGrLYVFQYH8) | 2000×2997 |
| `c21.logo` | Callejón 21 — Logo | [Christopher Jeffrey](https://unsplash.com/@christojeffrey) | [vDJm3OCLmhY](https://unsplash.com/photos/stainless-steel-spoons-in-black-steel-mesh-basket-vDJm3OCLmhY) | 4000×6000 |
| `c21.perro` | Callejón 21 — Perro Americano | [王 大洪](https://unsplash.com/@mr_wdh) | [m7w3hVqp0kQ](https://unsplash.com/photos/a-hot-dog-with-tomatoes-lettuce-and-mustard-m7w3hVqp0kQ) | 4160×6240 |
| `c21.salchipapa` | Callejón 21 — Salchipapa Ranchera | [CALEBE SOUSA](https://unsplash.com/@calebelima1101) | [nQaXivzVnkE](https://unsplash.com/photos/french-fries-topped-with-melted-cheese-and-sausage-nQaXivzVnkE) | 4000×6000 |
| `c21.pizza` | Callejón 21 — Pizza Mitad y Mitad | [amin ramezani](https://unsplash.com/@aminrmzni) | [FjyJ5D15j7c](https://unsplash.com/photos/a-pizza-cut-into-slices-with-vegetables-and-mushrooms-FjyJ5D15j7c) | 4000×4000 |
| `c21.mazorcada` | Callejón 21 — Mazorcada Mixta | [jaikishan patel](https://unsplash.com/@magictype) | [8TS2EvhugBI](https://unsplash.com/photos/cooked-corn-kennel-in-bowl-with-herb-8TS2EvhugBI) | 3783×2521 |
| `c21.cubano` | Callejón 21 — Sándwich Cubano | [Pooria Shahriari](https://unsplash.com/@pooria_shahriari) | [1cVBZz5pDrM](https://unsplash.com/photos/a-sandwich-with-meat-and-vegetables-1cVBZz5pDrM) | 4160×5200 |
| `c21.patacon` | Callejón 21 — Patacón con Todo | [solo seafood](https://unsplash.com/@soloseafood) | [6rbv0HrgefQ](https://unsplash.com/photos/a-plate-of-food-on-a-wooden-table-6rbv0HrgefQ) | 3510×5200 |
| `c21.choripapa` | Callejón 21 — Choripapa | [Nahima Aparicio](https://unsplash.com/@nahimaaparicio) | [PrOraTAsGsY](https://unsplash.com/photos/a-bowl-of-food-PrOraTAsGsY) | 3456×5184 |
| `c21.alitas` | Callejón 21 — Alitas BBQ x8 | [Atharva Tulsi](https://unsplash.com/@atharva_tulsi) | [Yh9Ut4d3K0A](https://unsplash.com/photos/savory-chicken-on-plate-Yh9Ut4d3K0A) | 4133×2812 |
| `c21.jugo` | Callejón 21 — Jugo Natural 16 oz | [Dhiren maru](https://unsplash.com/@dhirenmaru) | [vN1YusQcUJ4](https://unsplash.com/photos/three-yellow-orange-and-green-juice-in-clear-drinking-glasses-vN1YusQcUJ4) | 4513×3933 |
| `c21.gaseosa` | Callejón 21 — Gaseosa 1,5 L | [Oliver Plattner](https://unsplash.com/@oplattner) | [VyJhpWTO_1g](https://unsplash.com/photos/a-glass-bottle-with-a-clear-liquid-VyJhpWTO_1g) | 4600×6897 |
| `tul.cover` | Sazón de la Tulia — Portada | [Roberto Carlos Román Don](https://unsplash.com/@srcharls) | [TS_g_856-CA](https://unsplash.com/photos/white-rice-on-brown-ceramic-bowl-TS_g_856-CA) | 4046×2188 |
| `tul.logo` | Sazón de la Tulia — Logo | [Fantastic Ordinary](https://unsplash.com/@fantastic_ordinary) | [utzBpg0lhjM](https://unsplash.com/photos/a-bowl-of-food-on-a-plate-with-a-spoon-utzBpg0lhjM) | 3939×3939 |
| `tul.bandeja` | Sazón de la Tulia — Bandeja Paisa | [WILLIAN REIS](https://unsplash.com/@wriopomba) | [9MVNGosobLU](https://unsplash.com/photos/a-plate-of-food-on-a-wooden-table-9MVNGosobLU) | 3000×3488 |
| `tul.ajiaco` | Sazón de la Tulia — Ajiaco Santafereño | [Keesha's Kitchen](https://unsplash.com/@keeshasskitchen) | [gDwy_JEoz8k](https://unsplash.com/photos/a-bowl-of-soup-gDwy_JEoz8k) | 2832×4256 |
| `tul.sancocho` | Sazón de la Tulia — Sancocho Trifásico | [Jacques Bopp](https://unsplash.com/@jacquesbopp) | [QgCApKCfwcU](https://unsplash.com/photos/food-plate-QgCApKCfwcU) | 6965×3823 |
| `tul.mojarra` | Sazón de la Tulia — Mojarra Frita | [lalo Hernandez](https://unsplash.com/@lalonchera) | [nOpn-ScYv6A](https://unsplash.com/photos/fried-fish-with-sliced-lemon-nOpn-ScYv6A) | 6016×4016 |
| `tul.lechona` | Sazón de la Tulia — Lechona Tolimense | [Zion C](https://unsplash.com/@jcs_chen) | [ypLK2aLvF1Q](https://unsplash.com/photos/slices-of-crispy-roasted-pork-belly-on-a-white-plate-ypLK2aLvF1Q) | 5472×3648 |
| `tul.sobrebarriga` | Sazón de la Tulia — Sobrebarriga en Salsa Criolla | [Jacques Bopp](https://unsplash.com/@jacquesbopp) | [dDSH6Fz7_Uk](https://unsplash.com/photos/steamed-rice-and-meat-and-vegetable-slices-dDSH6Fz7_Uk) | 7366×3915 |
| `tul.empanadas` | Sazón de la Tulia — Empanadas de Pipián x4 | [Behnaz Kh](https://unsplash.com/@behnaz_khosravi) | [qarJ0gz2-YY](https://unsplash.com/photos/a-yellow-plate-topped-with-fried-food-on-top-of-a-table-qarJ0gz2-YY) | 5371×3581 |
| `tul.tamal` | Sazón de la Tulia — Tamal Tolimense | [Alyona Yankovska](https://unsplash.com/@alyonayankovska) | [OHLdFxbhjZU](https://unsplash.com/photos/a-white-plate-topped-with-two-enchiladas-and-a-fork-OHLdFxbhjZU) | 3024×4032 |
| `tul.arrozleche` | Sazón de la Tulia — Arroz con Leche | [Wil Carranza](https://unsplash.com/@wilcrza) | [VeRTm8WMTNM](https://unsplash.com/photos/a-plate-of-food-VeRTm8WMTNM) | 4000×4000 |
| `tul.limonada` | Sazón de la Tulia — Limonada de Panela | [Marina Grynykha](https://unsplash.com/@grynykha) | [ROyhcyMbScE](https://unsplash.com/photos/yellow-and-green-ceramic-mug-with-stainless-steel-spoon-ROyhcyMbScE) | 4000×6000 |
| `cyp.cover` | Carbón & Pan — Portada | [Jozsef Hocza](https://unsplash.com/@hocza) | [F1c4u9eSa4Y](https://unsplash.com/photos/burning-fire-on-charcoal-grill-F1c4u9eSa4Y) | 4787×3180 |
| `cyp.logo` | Carbón & Pan — Logo | [amin ramezani](https://unsplash.com/@aminrmzni) | [jLwJMtTqlV4](https://unsplash.com/photos/a-burger-with-cheese-and-vegetables-jLwJMtTqlV4) | 4000×4000 |
| `cyp.clasica` | Carbón & Pan — Clásica de la Casa | [Allen Rad](https://unsplash.com/@allenrad) | [9G_oJBKwi1c](https://unsplash.com/photos/cheese-burger-on-a-wooden-surface-9G_oJBKwi1c) | 2848×4288 |
| `cyp.smash` | Carbón & Pan — Doble Smash | [Eiliv Aceron](https://unsplash.com/@shootdelicious) | [pu6b4yIlQF4](https://unsplash.com/photos/double-cheeseburger-with-pickles-pu6b4yIlQF4) | 4000×6000 |
| `cyp.crispy` | Carbón & Pan — Crispy Chicken | [Rajasekhar R](https://unsplash.com/@rajasekhar21) | [VGXrtdLveYo](https://unsplash.com/photos/a-cheeseburger-on-a-wooden-board-VGXrtdLveYo) | 2624×3936 |
| `cyp.bbq` | Carbón & Pan — BBQ Ahumada | [amirali mirhashemian](https://unsplash.com/@amir_v_ali) | [9Bqiusimq6M](https://unsplash.com/photos/burger-with-cheese-and-lettuce-9Bqiusimq6M) | 5149×3433 |
| `cyp.veggie` | Carbón & Pan — Veggie de Garbanzo | [Inna Safa](https://unsplash.com/@innasafa) | [OIcAJ8Wixpo](https://unsplash.com/photos/a-stack-of-food-sitting-on-top-of-a-metal-rack-OIcAJ8Wixpo) | 3376×6000 |
| `cyp.papas` | Carbón & Pan — Papas Rústicas | [Pauline Loroy](https://unsplash.com/@paulinel) | [FNPnoX6EzY0](https://unsplash.com/photos/a-basket-of-french-fries-with-ketchup-and-ketchup-FNPnoX6EzY0) | 2848×4272 |
| `cyp.aros` | Carbón & Pan — Aros de Cebolla x10 | [Nathan Dumlao](https://unsplash.com/@nate_dumlao) | [CJC8sLgahjw](https://unsplash.com/photos/brown-bread-on-white-table-CJC8sLgahjw) | 8192×5464 |
| `cyp.nuggets` | Carbón & Pan — Nuggets de Pollo x8 | [Lee Milo](https://unsplash.com/@miloleetw) | [bG8sQGD8Bi8](https://unsplash.com/photos/basket-of-fried-chicken-tenders-fries-and-popcorn-chicken-bG8sQGD8Bi8) | 8192×5464 |
| `cyp.malteada` | Carbón & Pan — Malteada de Arequipe | [Aliona Gumeniuk](https://unsplash.com/@agumeniuk) | [skWmLMN6vFY](https://unsplash.com/photos/mug-of-shake-on-black-surface-skWmLMN6vFY) | 2480×3307 |
| `cyp.limonada` | Carbón & Pan — Limonada de Hierbabuena | [Francesca Hotchin](https://unsplash.com/@franhotchin) | [p5EiqkBYIEE](https://unsplash.com/photos/lime-juice-on-drinking-glass-beside-sliced-limes-p5EiqkBYIEE) | 5568×3712 |
| `tyt.cover` | Trigo & Tinto — Portada | [IRa Kang](https://unsplash.com/@lifeinkorea) | [WCMznkE93A4](https://unsplash.com/photos/variety-of-pastries-and-baked-goods-on-display-WCMznkE93A4) | 6000×4000 |
| `tyt.logo` | Trigo & Tinto — Logo | [Mehrpouya H](https://unsplash.com/@mehrpouya) | [vFWnvA6blhE](https://unsplash.com/photos/a-latte-with-foam-art-and-a-spoon-vFWnvA6blhE) | 3628×3628 |
| `tyt.capuchino` | Trigo & Tinto — Capuchino | [tabitha turner](https://unsplash.com/@tabithaturnervisuals) | [3n3mPoGko8g](https://unsplash.com/photos/white-ceramic-cup-with-saucer-on-brown-wooden-table-3n3mPoGko8g) | 3000×3996 |
| `tyt.tinto` | Trigo & Tinto — Tinto Campesino | [Indra Projects](https://unsplash.com/@indraprojects) | [ma90umjzwT4](https://unsplash.com/photos/a-cup-of-coffee-ma90umjzwT4) | 3098×2398 |
| `tyt.frappe` | Trigo & Tinto — Frappé de Café | [Diego Arenas de Rodrigo](https://unsplash.com/@diegoarenasderodrigo) | [gX8NNroI9Gg](https://unsplash.com/photos/a-chocolate-milkshake-with-chocolate-syrup-drizzle-gX8NNroI9Gg) | 2000×2997 |
| `tyt.pandebono` | Trigo & Tinto — Pandebono | [Luan Hobold](https://unsplash.com/@luanhobold) | [T3jGd7j8GLQ](https://unsplash.com/photos/a-round-herb-crusted-bread-roll-on-a-wooden-board-T3jGd7j8GLQ) | 4000×6000 |
| `tyt.almojabana` | Trigo & Tinto — Almojábana | [Rodrigo Rodrigues | WOLF Λ R T](https://unsplash.com/@wolfart32) | [pjjGmMtHjWc](https://unsplash.com/photos/a-bowl-of-golden-brown-cheese-bread-on-a-dark-surface-pjjGmMtHjWc) | 4000×6000 |
| `tyt.croissant` | Trigo & Tinto — Croissant de Almendras | [Redd Francisco](https://unsplash.com/@reddfrancisco) | [5HC8MhpE7dA](https://unsplash.com/photos/brown-and-white-bread-on-white-textile-5HC8MhpE7dA) | 3888×5184 |
| `tyt.desayuno` | Trigo & Tinto — Desayuno Huevos al Gusto | [Luke Tokaryk](https://unsplash.com/@lukelukeluke) | [VANvc2u1eic](https://unsplash.com/photos/a-white-plate-topped-with-eggs-and-toast-VANvc2u1eic) | 4672×7008 |
| `tyt.croissantjq` | Trigo & Tinto — Croissant de Jamón y Queso | [Vitalii Kyktov](https://unsplash.com/@i_am_vitality) | [wiWfgKrp0Q8](https://unsplash.com/photos/croissant-sandwich-with-melted-cheese-and-ham-wiWfgKrp0Q8) | 3464×3464 |
| `tyt.torta` | Trigo & Tinto — Torta de Zanahoria | [Bryony Elena](https://unsplash.com/@b_elena) | [N4b3Q1mfPWU](https://unsplash.com/photos/brown-and-white-cake-on-white-paper-N4b3Q1mfPWU) | 4160×6240 |
| `tyt.chocolate` | Trigo & Tinto — Chocolate Santafereño | [Emily Richards](https://unsplash.com/@emilyrichardsss) | [QD4g6u1-cS4](https://unsplash.com/photos/a-close-up-of-a-cup-of-food-on-a-table-QD4g6u1-cS4) | 2982×1988 |
| `sur.cover` | Autoservicio Punto Fresco — Portada | [ethan](https://unsplash.com/@andallthings) | [ihP15orhXT4](https://unsplash.com/photos/yellow-and-red-round-fruits-on-black-shelf-ihP15orhXT4) | 4032×3024 |
| `sur.logo` | Autoservicio Punto Fresco — Logo | [Sohel Rahman](https://unsplash.com/@s4smily) | [ev_dh3fXLgA](https://unsplash.com/photos/a-pile-of-baskets-filled-with-lots-of-fruits-and-vegetables-ev_dh3fXLgA) | 3011×2942 |
| `sur.huevos` | Autoservicio Punto Fresco — Huevos AA x30 | [Edouard Gilles](https://unsplash.com/@tontongilles) | [a5JMF6XyFYI](https://unsplash.com/photos/brown-and-white-heart-shaped-decor-a5JMF6XyFYI) | 2957×3696 |
| `sur.leche` | Autoservicio Punto Fresco — Leche Entera 1,1 L | [No Revisions](https://unsplash.com/@norevisions) | [juBur46D3VI](https://unsplash.com/photos/clear-glass-bottle-filled-with-white-liquid-juBur46D3VI) | 3481×4351 |
| `sur.arroz` | Autoservicio Punto Fresco — Arroz Blanco 1 kg | [Mehmet Keskin](https://unsplash.com/@keskinlerinmehmet) | [3zplOwmV6v0](https://unsplash.com/photos/a-bowl-of-rice-on-a-white-background-3zplOwmV6v0) | 7364×4909 |
| `sur.pan` | Autoservicio Punto Fresco — Pan Tajado Artesanal | [Charles Chen](https://unsplash.com/@color0911) | [e83dQJ-BMog](https://unsplash.com/photos/brown-bread-on-white-ceramic-plate-e83dQJ-BMog) | 6720×4480 |
| `sur.aguacate` | Autoservicio Punto Fresco — Aguacate Hass (unidad) | [Gil Ndjouwou](https://unsplash.com/@gilndjouwou) | [cueV_oTVsic](https://unsplash.com/photos/sliced-avocado-fruit-on-brown-wooden-table-cueV_oTVsic) | 6000×4000 |
| `sur.tomate` | Autoservicio Punto Fresco — Tomate Chonto (libra) | [Alex Ghizila](https://unsplash.com/@galex) | [UD_j10SKj5g](https://unsplash.com/photos/three-cherry-tomatoes-UD_j10SKj5g) | 6016×4000 |
| `sur.queso` | Autoservicio Punto Fresco — Queso Campesino 500 g | [Christina](https://unsplash.com/@christina_92) | [jntQPBIK_sE](https://unsplash.com/photos/a-plate-of-cheese-jntQPBIK_sE) | 3819×5728 |
| `sur.cerveza` | Autoservicio Punto Fresco — Cerveza Nacional six pack | [felix jiricka](https://unsplash.com/@felixjiricka) | [OnSNsswS2gc](https://unsplash.com/photos/a-close-up-of-three-bottles-of-beer-OnSNsswS2gc) | 6000×4000 |
| `sur.agua` | Autoservicio Punto Fresco — Agua sin Gas 600 ml | [Steve A Johnson](https://unsplash.com/@steve_j) | [N-MqWXXZvNY](https://unsplash.com/photos/clear-drinking-bottle-filled-with-water-N-MqWXXZvNY) | 3328×1864 |
| `sur.detergente` | Autoservicio Punto Fresco — Detergente en Polvo 1 kg | [HowToGym](https://unsplash.com/@howtogym) | [S9NchuPb79I](https://unsplash.com/photos/scoop-with-white-powder-S9NchuPb79I) | 3860×2575 |

## Cómo se usa

```bash
cd backend
npm run teste:api-smoke -- --label=antes      # con el backend corriendo
npm run teste:seed     -- --db=<nombre>       # idempotente, no borra nada
npm run teste:api-smoke -- --label=despues    # compara con la de antes
npm run teste:validate -- --db=<nombre>       # solo lectura; PASS/FAIL
npm run teste:teardown -- --db=<nombre>       # simulación; añade --apply para borrar
```

Todos se niegan a correr con `NODE_ENV=production` y exigen `--db=<nombre>` igual al de la conexión. `teste:seed` deja `teste.manifest.json` con los ids sembrados.

## Estrategia de pruebas

Tres capas, de más barata a más cara:

1. **Automática en memoria** (`npm test`): `testeCatalog.test.ts` siembra el TESTE completo en una Mongo efímera y recorre por HTTP las filas marcadas ✅ abajo. Es lo que corre en cada cambio.
2. **Validación contra la base sembrada** (`teste:validate`): relaciones, precios, límites de los grupos, fotos vivas y coherencia de los pedidos ya creados. Solo lectura.
3. **Manual en los tres frontends**: las filas ✋, que necesitan ojo humano (que la hoja se vea bien, que el ticket de cocina se lea, que el horario se pinte).

Lo que se cubre en cada una está en la columna *Dónde*.

## Matriz de escenarios

| ID | Escenario | Datos del TESTE | Esperado | Dónde |
|---|---|---|---|---|
| M-01 | Combinación máxima | 2× Clásica de la Casa: Angus, cheddar, tocineta doble, chipotle, papas rústicas, limonada | (22.900+7.000+2.500+6.000+1.000+6.500+5.500)×2 = **$102.800** | ✅ auto |
| M-02 | Grupo obligatorio omitido | Clásica de la Casa sin "Tipo de carne" | 400 `MODIFIER_REQUIRED`; en la app, la hoja baja al grupo y lo resalta | ✅ auto + ✋ |
| M-03 | Mínimo = máximo = 2 | Mojarra Frita con un solo acompañante | 400 `MODIFIER_REQUIRED` | ✅ auto |
| M-04 | Exceso sobre el máximo | Nuggets con 3 salsas (máx. 2) | 400 `MODIFIER_TOO_MANY` | ✅ auto |
| M-05 | Opción agotada | Bandeja Paisa + "Chicharrón extra" | 400 `MODIFIER_UNAVAILABLE`; en la app sale inactiva con "Agotado" | ✅ auto + ✋ |
| M-06 | Precio manipulado | Capuchino con `price: -99999` en una opción | Se ignora; cobra el precio de la base de datos | ✅ auto |
| M-07 | Seis grupos a la vez | Pizza Mitad y Mitad: familiar, delgada, 2 sabores, borde de queso | $59.900 | ✅ auto |
| M-08 | Todo opcional a cero | Perro Americano solo con salsas ($0) | Cobra $12.900 exactos | ✋ |
| C-01 | Mismo producto, distinta selección | 2 capuchinos, uno con leche de almendras | Dos líneas separadas en el carrito | ✅ auto (store) |
| C-02 | Sugerencia con obligatorios | "Para acompañar" ofrece el Capuchino | Abre su hoja en vez de agregarlo a ciegas | ✋ |
| C-03 | Carrito de dos negocios | Agregar de Callejón 21 y luego de Carbón & Pan | El carrito se reemplaza, avisando | ✋ |
| S-01 | Última unidad | Croissant de Almendras con stock 1, dos clientes a la vez | Uno 201, otro 409 `OUT_OF_STOCK`; stock 0 | ✅ auto |
| S-02 | Producto agotado | Torta de Zanahoria (stock 0) | No aparece en la carta; por API, 400 | ✅ auto |
| S-03 | Aviso de poco inventario | Croissant (stock 6, aviso en 3) | El panel avisa al bajar de 3 | ✋ |
| H-01 | Día cerrado | Sazón de la Tulia un lunes | La app dice "Cerrado hoy" y no deja agregar. **La API sí acepta** (limitación L-3) | ✋ |
| H-02 | Cierre pasada la medianoche | Callejón 21 a las 00:30 (abre 16:00–01:00) | Debería estar abierto; **la app lo muestra cerrado** (limitación L-4) | ✋ |
| H-03 | Horario reducido | Trigo & Tinto un domingo a las 15:00 (cierra 14:00) | Cerrado, con "Abre a las 7:00 a. m." | ✋ |
| B-01 | Interruptor de cerrado | Desactivar Trigo & Tinto desde el panel | Desaparece del listado; la API responde 404 | ✅ auto |
| O-01 | Ciclo completo | Pedido → aceptar → preparar → listo → asignar → recoger → entregar | Estado `delivered` y línea de tiempo con sus hitos | ✅ auto |
| O-02 | Cancelación del cliente | Pedido pendiente de Huevos AA x30 (2 unidades) | Cancelado y stock devuelto (10 → 12) | ✅ auto |
| O-03 | Rechazo del comercio | Motivo `business_out_of_stock` | Queda registrado el código, no solo el texto | ✅ auto |
| O-04 | Doble envío | Misma `idempotencyKey` dos veces | Un solo pedido y un solo aviso a la cocina | ✅ auto |
| O-05 | Reintento por timeout | Cuatro peticiones simultáneas con la misma clave | Un pedido; el stock baja una sola vez | ✅ auto |
| A-01 | Mayor de edad | Cerveza Nacional six pack | El pedido nace con `requiresAgeVerification` | ✅ auto |
| P-01 | Pedido mínimo | Punto Fresco con $5.000 en agua | Rechazado por no llegar a $15.000 | ✅ auto |
| P-02 | Envío gratis | Callejón 21 con más de $45.000 | El envío queda en cero | ✋ |
| R-01 | "Lo de siempre" | Repetir el capuchino con leche de almendras | Mismo carrito, mismos `optionId`, mismo total | ✅ auto |
| R-02 | Producto sin modificadores | Gaseosa 1,5 L | La hoja no muestra ninguna sección de grupos | ✋ |
| SEC-01 | Opción de otro producto | `optionId` de la Bandeja en la Clásica | 400 `MODIFIER_UNKNOWN` | ✅ auto |
| SEC-06 | Editar la carta ajena | El dueño de Carbón & Pan edita un producto de Punto Fresco | 403, sin cambios | ✅ auto |

## FASE 6 — REGRESIÓN Y SEGURIDAD

Cierre del 2026-09-15. Demuestra que los grupos de modificadores y el TESTE no rompen lo que ya existía, y deja por escrito lo que se encontró de camino.

### Pruebas ejecutadas

| Suite | Comando | Antes | Después |
|---|---|---|---|
| Backend (vitest) | `npm test` | 68 archivos · 981 pruebas ✅ | 72 archivos · 1.042 pruebas ✅ |
| Móvil (jest) | `npm test` | 5 archivos · 28 pruebas ✅ | 6 archivos · 47 pruebas ✅ |
| Panel comercio (vitest) | `npm test` | no existía runner | 1 archivo · 16 pruebas ✅ |
| Tipos | `tsc --noEmit / tsc -b` | limpio | limpio en backend, móvil y panel |
| Lint del panel | `npx eslint src` | 2 errores · 16 avisos (Settlements.tsx, preexistente) | los mismos 2 errores · 16 avisos — ninguno en lo nuevo |

### Errores encontrados y corregidos

Los cinco se encontraron **leyendo el código**, se reprodujeron con una prueba que falla, y esa misma prueba pasa con la corrección.

#### F-1 · El stock reservado no volvía cuando la creación del pedido fallaba _(alta)_

- **Dónde:** services/order.service.ts — `create`, tres ramas de salida
- **Qué pasaba:** Cuatro reintentos simultáneos con la misma `idempotencyKey` sobre un producto con 5 unidades dejaban **1 unidad** y un solo pedido: se perdían 3. Igual con el cupón agotado y con un fallo del libro mayor.
- **Corrección:** Se llama al `releaseStock` que ya existía en las tres ramas, dentro de un `undoReservation` que además vuelve a encender el producto si la reserva fue la que lo apagó. — *corregido*

#### F-2 · `idempotencyKey` sin ámbito por cliente _(alta)_

- **Dónde:** services/order.service.ts — búsqueda previa y captura del error 11000
- **Qué pasaba:** Un segundo cliente que mandara la misma clave recibía **el pedido del primero**, con su dirección y sus productos (201 en vez de rechazo).
- **Corrección:** La búsqueda filtra por `clientId`; una clave ajena responde `409 IDEMPOTENCY_KEY_CONFLICT` sin revelar nada del pedido que la ocupa. Sin tocar el índice único ni migrar Atlas. — *corregido*

#### F-3 · La réplica idempotente volvía a sonar en la cocina _(media)_

- **Dónde:** controllers/order.controller.ts — emisión de `order:incoming`
- **Qué pasaba:** El doble toque en "Pagar" emitía dos veces `order:incoming`, `order:available` y `order:new`: el panel del comercio recibía el mismo pedido dos veces y se ofrecía dos veces a los domiciliarios.
- **Corrección:** El servicio marca la réplica con `order.$locals.replayed` (mecanismo nativo de Mongoose, sin cambiar la firma de `create`) y el controlador no emite en ese caso. — *corregido*

#### F-4 · `selectedExtras` sin tope de longitud _(baja)_

- **Dónde:** validators/order.validator.ts
- **Qué pasaba:** Una sola línea con 51 adicionales se aceptaba y el servidor los resolvía uno por uno contra el producto en cada cotización.
- **Corrección:** Tope de 50 por línea, que ningún plato real alcanza. — *corregido*

#### L-6 · `productService.create` descartaba inventario y mayoría de edad _(alta)_

- **Dónde:** services/product.service.ts — `create`
- **Qué pasaba:** Crear un producto con `stock`, `lowStockThreshold` o `requiresAgeVerification` los guardaba en **null/false**: el validador los dejaba pasar y el servicio no los copiaba. Solo se guardaban al editar, y sin ningún error que lo dijera.
- **Corrección:** Se copian los tres campos, y con `stock: 0` el producto nace agotado, igual que al editar. — *corregido*

### Comprobaciones

| ID | Qué se comprueba | Resultado |
|---|---|---|
| R-01 | Producto sin grupos ni extras: precio, cotización, pedido y JSON | ✅ idénticos a la línea base |
| R-02 | Producto solo con `extras[]` heredados (nombre + cantidad) | ✅ mismas pruebas de `pricing.test.ts` sin cambios |
| R-03 | Producto con grupos: M-01…M-07 | ✅ |
| R-04 | Producto mixto: un extra plano y una opción que se llaman igual | ✅ suman por separado y no se confunden |
| R-05 | Checkout: (unidad + extras + opciones) × cantidad, subtotal y `finance` | ✅ |
| R-06 | La copia del pedido guarda `groupId`/`groupName`/`optionId`; los pedidos viejos se siguen leyendo | ✅ |
| R-07 | Inmutabilidad: subir precios y borrar una opción después del pedido | ✅ el pedido releído no cambia |
| R-08 | Inventario y reserva atómica, también con productos con grupos | ✅ `stock.test.ts` completo + casos nuevos |
| R-09 | Cancelar devuelve el stock exacto con dos líneas del mismo producto | ✅ 10 → 5 → 10 |
| R-10 | Panel: crear, editar y borrar grupos sin romper el producto | ✅ un PUT sin `modifierGroups` no los toca; con ids, los conserva |
| R-11 | Crear sin inventario deja `stock` en null, no en cero | ✅ |
| C-01 | Dos líneas del mismo producto con distinta selección | ✅ no se fusionan; misma opción renombrada sí |
| UI | Producto sin grupos: no aparece ninguna UI de grupos | ✅ `hasModifierUI` en falso, sección no renderizada |
| SEC-01 | `optionId` de otro producto | ✅ 400 `MODIFIER_UNKNOWN` |
| SEC-02 | `groupId` de otro producto, y opción bajo el grupo equivocado | ✅ 400 `MODIFIER_UNKNOWN` |
| SEC-03 | Producto de otro comercio dentro del pedido | ✅ 400, sin stock reservado |
| SEC-04 | Precios del cliente: 0, −1, 999999999, distinto al de la base | ✅ ignorados; se cobra el de la base de datos |
| SEC-05 | `idempotencyKey` de otro cliente | ✅ 409, sin filtrar el pedido ajeno (era 201 antes de F-2) |
| SEC-06 | El dueño de un comercio edita los grupos de otro | ✅ 403 con `businessId` propio o ajeno |
| SEC-07 | Ids mal formados y `{"$ne": null}` como `optionId` | ✅ 400 de validación, nunca 500 |
| SEC-08 | 51 adicionales en una línea; opción repetida en el grupo | ✅ 400 (F-4) y `MODIFIER_DUPLICATE` |
| SEC-09 | Grupos incoherentes desde el panel (mín > máx, máx > opciones, precio negativo o decimal, nombres repetidos) | ✅ 400 y el producto queda intacto |
| O-04 | Doble envío secuencial con la misma clave | ✅ un pedido, un aviso, stock descontado una vez |
| O-05 | Cuatro peticiones simultáneas con la misma clave | ✅ un pedido, stock −1 (antes −4) |
| CON-01 | Dos clientes por la última unidad, con modificadores | ✅ uno 201, otro 409 |
| CON-02 | Mismo usuario, dos dispositivos, claves distintas | ✅ 201 + 409 `OUT_OF_STOCK` |
| CON-04 | Dos clientes simultáneos con el mismo producto y la misma selección | ✅ mismos totales, stock correcto |
| CON-05 | Cancelar mientras otro reserva, y doble cancelación simultánea | ✅ stock final coherente, devuelto una sola vez |
| CON-06 | Ráfaga de 20 pedidos contra 5 unidades | ✅ exactamente 5 pasan, 15 dan 409, nunca `stock < 0` |
| CON-07 | Cupón agotado con el stock ya reservado | ✅ el stock vuelve (antes se perdía) |
| API | Contrato de 22 rutas: estado, forma del JSON y dinero | ✅ sin rupturas; solo campos nuevos de la lista autorizada |
| TESTE | Siembra, idempotencia (dos corridas), validador y matriz por HTTP | ✅ 18 pruebas |

### Limitaciones pendientes

- **L-3** El backend no comprueba el horario al crear el pedido: `isCurrentlyOpen()` existe y no lo llama nadie, usa la zona horaria del servidor y no maneja el cierre pasada la medianoche. Hoy solo lo frena la app (fila H-01).
- **L-4** `openState()` en el móvil, pasada la medianoche, mira el horario de *hoy* en vez del de *ayer*: Callejón 21 (16:00–01:00) aparece cerrado a las 00:30 (fila H-02).
- **L-5** Cerrar el negocio con el interruptor lo **oculta** del listado en lugar de mostrarlo "Cerrado" (fila B-01).
- **L-13** La misma `idempotencyKey` con otro carrito devuelve el pedido original sin avisar. Propuesta: guardar una huella SHA-256 de `businessId + items` junto a la clave y responder `422 IDEMPOTENCY_KEY_MISMATCH`. **No se implementó**: añade un campo al pedido y eso es una decisión, no un arreglo.
- **L-14** No hay transacción entre `reserveStock` y `Order.create`: si el proceso se cae justo entre los dos, las unidades quedan apartadas. Propuesta: transacción de Mongo (Atlas es replica set) o un barrido de reservas huérfanas.
- **L-2** No existe tiempo de preparación por producto; solo `Business.deliveryTime`. No se añadió porque sería un campo que nada consume.
- **L-9** No hay modificadores condicionales ("Término" solo si la carne es de res) ni cantidad por opción. El grupo "Término" del TESTE es opcional por eso.
- **L-10** El rate limit de 100 peticiones cada 15 minutos por IP puede vaciar los paneles durante una sesión de pruebas manuales.

### Veredicto: **PASS**

Todas las pruebas existentes siguen pasando, las nuevas también, no quedan hallazgos altos abiertos, no hay pedidos duplicados ni stock negativo, ningún precio se puede fijar desde el cliente, no hay referencias cruzadas entre comercios, el seed es idempotente y el teardown es reversible. Las limitaciones pendientes son de horarios y de idempotencia avanzada, están documentadas y ninguna corrompe datos.
